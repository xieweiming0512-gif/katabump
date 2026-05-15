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
        // 监控 ALTCHA (续期用)
        const altchaInput = document.querySelector('input[name="altcha"]');
        if (altchaInput && altchaInput.value && altchaInput.value.length > 30) {
            window.__altcha_done = true;
        }
        
        // 监控 Turnstile (登录用)
        if (window.turnstile) {
             const widget = document.querySelector('[id^="cf-chl-widget-"]');
             if (widget) window.__has_turnstile = true;
        }
    }, 1000);

    // 拦截 ShadowRoot 寻找复选框坐标
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(init) {
        const shadowRoot = originalAttachShadow.call(this, init);
        setTimeout(() => {
            const check = () => {
                const cb = shadowRoot.querySelector('input[type="checkbox"]');
                if (cb) {
                    const rect = cb.getBoundingClientRect();
                    window.__turnstile_data = { 
                        xRatio: (rect.left + rect.width / 2) / window.innerWidth,
                        yRatio: (rect.top + rect.height / 2) / window.innerHeight
                    };
                }
            };
            check();
            new MutationObserver(check).observe(shadowRoot, {childList:true, subtree:true});
        }, 100);
        return shadowRoot;
    };
})();
`;

async function handleCaptcha(page, context = 'login') {
    console.log(`   >> [${context}] 正在处理验证码...`);
    
    // 优先检测 Cloudflare Turnstile (通常在登录页)
    for (let i = 0; i < 15; i++) {
        const turnstileData = await page.evaluate(() => window.__turnstile_data).catch(() => null);
        if (turnstileData) {
            console.log('   >> 检测到 Turnstile 复选框，尝试 CDP 点击...');
            const frames = page.frames();
            for (const frame of frames) {
                const iframeElement = await frame.frameElement().catch(() => null);
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (box && box.width > 0) {
                    const clickX = box.x + (box.width * turnstileData.xRatio);
                    const clickY = box.y + (box.height * turnstileData.yRatio);
                    const client = await page.context().newCDPSession(page);
                    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickX, y: clickY, button: 'left', clickCount: 1 });
                    await client.detach();
                    console.log('   >> CDP 点击已发送。');
                    await page.waitForTimeout(3000);
                    return true;
                }
            }
        }
        
        // 检查 ALTCHA (通常在续期弹窗)
        const isAltchaDone = await page.evaluate(() => window.__altcha_done).catch(() => false);
        if (isAltchaDone) {
            console.log('   >> ✅ ALTCHA PoW 计算完成。');
            return true;
        }
        
        await page.waitForTimeout(1000);
    }
    console.log('   >> 未能自动完成验证，尝试继续后续操作...');
    return false;
}

async function launchChrome() {
    const args = [`--remote-debugging-port=${DEBUG_PORT}`, '--no-sandbox', '--disable-gpu', '--user-data-dir=/tmp/chrome_user_data'];
    if (PROXY_CONFIG) args.push(`--proxy-server=${PROXY_CONFIG.server}`);
    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();
    for (let i = 0; i < 20; i++) {
        const portOpen = await new Promise(res => {
            const req = http.get(`http://localhost:${DEBUG_PORT}/json/version`, () => res(true)).on('error', () => res(false));
            req.end();
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

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length}: ${user.username} ===`);

        try {
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(3000);

            if (await page.getByRole('textbox', { name: 'Email' }).isVisible()) {
                await page.getByRole('textbox', { name: 'Email' }).fill(user.username);
                await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
                
                await handleCaptcha(page, 'Login'); 
                await page.getByRole('button', { name: 'Login' }).click();
                await page.waitForTimeout(5000);
            }

            // 检查是否登录成功
            if (page.url().includes('/auth/login')) {
                 console.log('   >> 登录未跳转，尝试第二次点击登录按钮...');
                 await page.getByRole('button', { name: 'Login' }).click();
                 await page.waitForTimeout(5000);
            }

            await page.goto('https://dashboard.katabump.com/dashboard/server');
            const seeBtn = page.getByRole('link', { name: 'See' }).first();
            await seeBtn.waitFor({ state: 'visible', timeout: 15000 });
            await seeBtn.click();
            
            // Renew 逻辑
            await page.waitForTimeout(3000);
            const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
            
            if (await renewBtn.isVisible()) {
                await renewBtn.click();
                await page.locator('#renew-modal').waitFor({ state: 'visible' });
                console.log('   >> 续期弹窗已打开');

                await handleCaptcha(page, 'Renew'); // 这里处理 ALTCHA
                
                const shot = path.join(photoDir, `${user.username}_renew.png`);
                await page.screenshot({ path: shot });

                await page.locator('#renew-modal').getByRole('button', { name: 'Renew' }).click();
                await page.waitForTimeout(4000);
                
                if (!await page.locator('#renew-modal').isVisible()) {
                    console.log('   >> ✅ 续期指令发送成功！');
                    await sendTelegramMessage(`✅ 用户 ${user.username} 续期操作完成`, shot);
                } else {
                    console.log('   >> ⚠️ 续期弹窗仍未关闭，可能失败。');
                }
            } else {
                console.log('   >> 💡 未发现 Renew 按钮，可能时间未到。');
            }

        } catch (err) {
            console.error(`   >> ❌ 运行出错: ${err.message}`);
            await page.screenshot({ path: path.join(photoDir, `${user.username}_error.png`) });
        }
    }

    await browser.close();
    process.exit(0);
})();
