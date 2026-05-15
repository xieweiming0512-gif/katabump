const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send message:', e.message);
    }

    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] Sending photo...');
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] Failed to send photo via curl:', err.message);
                else console.log('[Telegram] Photo sent.');
                resolve();
            });
        });
    }
}

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
process.env.NO_PROXY = 'localhost,127.0.0.1';

const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式无效。');
        process.exit(1);
    }
}

// 核心改进：注入脚本支持 ALTCHA
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    // 模拟鼠标坐标
    try {
        function getRandomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: getRandomInt(800, 1200) });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: getRandomInt(400, 600) });
    } catch (e) { }

    // 监控 ALTCHA 状态
    setInterval(() => {
        const altchaInput = document.querySelector('input[name="altcha"]');
        if (altchaInput && altchaInput.value && altchaInput.value.length > 20) {
            window.__altcha_done = true;
        }
        
        // 监控旧版 Turnstile 数据
        const turnstileData = window.__turnstile_data;
        if (turnstileData) window.__captcha_detected = 'turnstile';
    }, 1000);

    // 原有的 ShadowRoot Hook 保持不变，用于兼容旧版
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            window.__turnstile_data = { 
                                xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                                yRatio: (rect.top + rect.height / 2) / window.innerHeight
                            };
                            return true;
                        }
                    }
                    return false;
                };
                const observer = new MutationObserver(() => { if (checkAndReport()) observer.disconnect(); });
                observer.observe(shadowRoot, { childList: true, subtree: true });
            }
            return shadowRoot;
        };
    } catch (e) {}
})();
`;

// 新增：ALTCHA 处理逻辑
async function handleCaptcha(page) {
    console.log('   >> 正在识别验证码类型...');
    
    // 1. 尝试检测并点击 Turnstile
    let cdpResult = await attemptTurnstileCdp(page);
    if (cdpResult) {
        console.log('   >> 检测到 Turnstile，已尝试 CDP 点击。等待 5秒...');
        await page.waitForTimeout(5000);
        return true;
    }

    // 2. 尝试处理 ALTCHA
    console.log('   >> 未发现 Turnstile，检查 ALTCHA...');
    const altchaWidget = page.locator('altcha-widget');
    if (await altchaWidget.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log('   >> 发现 ALTCHA 挂件，正在等待 PoW 计算...');
        // ALTCHA 有时需要点击一下中间的复选框才会开始计算
        try {
            const box = await altchaWidget.boundingBox();
            if (box) await page.mouse.click(box.x + 30, box.y + 30);
        } catch(e) {}

        for (let i = 0; i < 30; i++) {
            const isDone = await page.evaluate(() => window.__altcha_done).catch(() => false);
            if (isDone) {
                console.log('   >> ✅ ALTCHA 计算完成！');
                await page.waitForTimeout(2000);
                return true;
            }
            await page.waitForTimeout(1000);
        }
        console.log('   >> ⚠️ ALTCHA 等待超时。');
    }
    return false;
}

async function checkProxy() {
    if (!PROXY_CONFIG) return true;
    try {
        const axiosConfig = {
            proxy: { protocol: 'http', host: new URL(PROXY_CONFIG.server).hostname, port: new URL(PROXY_CONFIG.server).port },
            timeout: 10000
        };
        if (PROXY_CONFIG.username) axiosConfig.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
        await axios.get('https://www.google.com', axiosConfig);
        return true;
    } catch (error) { return false; }
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    if (await checkPort(DEBUG_PORT)) return;
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data',
        '--disable-dev-shm-usage'
    ];
    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }
}

function getUsers() {
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) { console.error('USERS_JSON 解析错误'); }
    return [];
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                const iframeElement = await frame.frameElement();
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                await client.detach();
                return true;
            }
        } catch (e) { }
    }
    return false;
}

(async () => {
    const users = getUsers();
    if (PROXY_CONFIG && !(await checkProxy())) process.exit(1);
    await launchChrome();

    let browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        await context.setHTTPCredentials({ username: PROXY_CONFIG.username, password: PROXY_CONFIG.password });
    }

    await page.addInitScript(INJECTED_SCRIPT);
    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);

            // 登录页处理
            const emailInput = page.getByRole('textbox', { name: 'Email' });
            if (await emailInput.isVisible({ timeout: 5000 })) {
                await emailInput.fill(user.username);
                await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
                
                await handleCaptcha(page); // 处理登录验证码
                await page.getByRole('button', { name: 'Login', exact: true }).click();
                
                if (await page.getByText('Incorrect password').isVisible({ timeout: 3000 })) {
                    console.error(`登录失败: ${user.username}`);
                    continue;
                }
            }

            // 进入服务器详情
            await page.goto('https://dashboard.katabump.com/dashboard/server');
            await page.getByRole('link', { name: 'See' }).first().click();
            await page.waitForTimeout(2000);

            // Renew 循环
            let renewDone = false;
            for (let attempt = 1; attempt <= 3; attempt++) {
                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    const modal = page.locator('#renew-modal');
                    await modal.waitFor({ state: 'visible' });

                    await handleCaptcha(page); // 处理续期验证码 (ALTCHA)
                    
                    const shotPath = path.join(photoDir, `${safeUser}_renew_atmp_${attempt}.png`);
                    await page.screenshot({ path: shotPath });

                    await modal.getByRole('button', { name: 'Renew' }).click();
                    await page.waitForTimeout(3000);

                    if (await page.getByText("You can't renew your server yet").isVisible()) {
                        console.log('⏳ 尚未到续期时间。');
                        renewDone = true;
                        break;
                    }

                    if (!await modal.isVisible()) {
                        console.log('✅ 续期成功！');
                        await sendTelegramMessage(`✅ 用户 ${user.username} 续期成功`, shotPath);
                        renewDone = true;
                        break;
                    }
                    await page.reload();
                    await page.waitForTimeout(3000);
                } else {
                    console.log('未发现 Renew 按钮，可能已续期。');
                    break;
                }
            }
        } catch (err) {
            console.error(`处理用户出错:`, err.message);
        }
        await page.screenshot({ path: path.join(photoDir, `${safeUser}_final.png`) });
    }

    await browser.close();
    process.exit(0);
})();
