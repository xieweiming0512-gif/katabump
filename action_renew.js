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
        console.log('[Telegram] 消息已发送');
    } catch (e) {
        console.error('[Telegram] 发送失败:', e.message);
    }

    if (imagePath && fs.existsSync(imagePath)) {
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        exec(cmd);
    }
}

chromium.use(stealth);

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;
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
    } catch (e) {}
}

const INJECTED_SCRIPT = `
(function() {
    setInterval(() => {
        // 监控 ALTCHA (续期弹窗用)
        const altchaInput = document.querySelector('input[name="altcha"]');
        if (altchaInput && altchaInput.value && altchaInput.value.length > 30) {
            window.__altcha_done = true;
        }
    }, 1000);

    // 监控 ShadowRoot 寻找 Cloudflare 复选框坐标
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
        const shadowRoot = originalAttachShadow.call(this, init);
        const check = () => {
            const cb = shadowRoot.querySelector('input[type="checkbox"]');
            if (cb) {
                const rect = cb.getBoundingClientRect();
                if (rect.width > 0) {
                    window.__turnstile_data = { 
                        xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                        yRatio: (rect.top + rect.height / 2) / window.innerHeight
                    };
                }
            }
        };
        setInterval(check, 1000);
        return shadowRoot;
    };
})();
`;

async function handleCaptcha(page, context = 'login') {
    console.log(`   >> [${context}] 正在检测验证码...`);
    
    for (let i = 0; i < 20; i++) {
        // 1. 处理 Cloudflare Turnstile
        const turnstileData = await page.evaluate(() => window.__turnstile_data).catch(() => null);
        if (turnstileData) {
            console.log('   >> 发现 Turnstile 复选框，执行 CDP 点击...');
            const frames = page.frames();
            for (const frame of frames) {
                const iframe = await frame.frameElement().catch(() => null);
                if (!iframe) continue;
                const box = await iframe.boundingBox();
                if (box && box.width > 0) {
                    const clickX = box.x + (box.width * turnstileData.xRatio);
                    const clickY = box.y + (box.height * turnstileData.yRatio);
                    const client = await page.context().newCDPSession(page);
                    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                    await client.detach();
                }
            }
        }
        
        // 2. 处理 ALTCHA
        const isAltchaDone = await page.evaluate(() => window.__altcha_done).catch(() => false);
        if (isAltchaDone) {
            console.log('   >> ✅ ALTCHA 验证完成');
            return true;
        }
        
        // 检查页面是否已经通过验证 (例如登录按钮变亮或加载条消失)
        await page.waitForTimeout(1000);
    }
    return false;
}

async function launchChrome() {
    const args = [`--remote-debugging-port=${DEBUG_PORT}`, '--no-sandbox', '--disable-gpu', '--user-data-dir=/tmp/chrome_user_data'];
    if (PROXY_CONFIG) args.push(`--proxy-server=${PROXY_CONFIG.server}`);
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();
    for (let i = 0; i < 20; i++) {
        const portOpen = await new Promise(res => {
            http.get(`http://localhost:${DEBUG_PORT}/json/version`, () => res(true)).on('error', () => res(false)).end();
        });
        if (portOpen) break;
        await new Promise(r => setTimeout(r, 1000));
    }
}

(async () => {
    let users = [];
    try { users = JSON.parse(process.env.USERS_JSON).users || JSON.parse(process.env.USERS_JSON); } catch (e) {}
    
    await launchChrome();
    const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
    const context = browser.contexts()[0];
    const page = await context.newPage();
    await page.addInitScript(INJECTED_SCRIPT);

    const photoDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

    for (const user of users) {
        console.log(`\n=== 用户: ${user.username} ===`);
        try {
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(3000);

            if (await page.getByRole('textbox', { name: 'Email' }).isVisible()) {
                await page.getByRole('textbox', { name: 'Email' }).fill(user.username);
                await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
                
                await handleCaptcha(page, 'Login'); 
                // 修复严格模式：明确指定点击第一个 "Login" 按钮，且排除 Discord 按钮
                await page.getByRole('button', { name: 'Login', exact: true }).click();
                await page.waitForTimeout(5000);
            }

            if (page.url().includes('/auth/login')) {
                console.log('   >> 登录未跳转，尝试二次确认...');
                await page.getByRole('button', { name: 'Login', exact: true }).click();
                await page.waitForTimeout(5000);
            }

            await page.goto('https://dashboard.katabump.com/dashboard/server');
            const seeBtn = page.getByRole('link', { name: 'See' }).first();
            await seeBtn.waitFor({ state: 'visible', timeout: 15000 });
            await seeBtn.click();
            
            await page.waitForTimeout(3000);
            const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
            
            if (await renewBtn.isVisible()) {
                await renewBtn.click();
                const modal = page.locator('#renew-modal');
                await modal.waitFor({ state: 'visible' });

                await handleCaptcha(page, 'Renew'); 
                
                const shot = path.join(photoDir, `${user.username}_renew.png`);
                await page.screenshot({ path: shot });

                await modal.getByRole('button', { name: 'Renew' }).click();
                await page.waitForTimeout(4000);
                
                if (!await modal.isVisible()) {
                    console.log('   >> ✅ 续期操作成功');
                    await sendTelegramMessage(`✅ 用户 ${user.username} 续期成功`, shot);
                }
            } else {
                console.log('   >> 💡 尚未到续期时间');
            }
        } catch (err) {
            console.error(`   >> ❌ 错误: ${err.message}`);
            await page.screenshot({ path: path.join(photoDir, `${user.username}_err.png`) });
        }
    }
    await browser.close();
    process.exit(0);
})();
