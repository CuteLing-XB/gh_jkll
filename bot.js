const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const axios = require('axios');
require('dotenv').config();

// ================= 配置区 =================
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_KEYS_PATH = process.env.GITHUB_PATH || 'keys.txt';
const PORT = process.env.PORT || 3000;
const AUTH_SECRET = process.env.AUTH_SECRET || "XiaoLin666";

const KEY_TIMEOUT_MINUTES = 10; // 领卡 10 分钟未绑定自动回收
const RECLAIM_CHECK_INTERVAL_MINUTES = 2; // 每 2 分钟检查一次回收

// keyStore: Map<Key, { status: 'EMPTY' | 'CLAIMED' | 'BOUND' | 'DISABLED', hwid?: string, ip?: string, claimedAt?: number }>
const keyStore = new Map();
const activeUsers = new Map();

let keysSha = null;
let isSavingKeys = false;
let saveTimer = null; // 用于防抖节流的定时器

const githubHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'KeyAuth-FastBot'
};

// 判断一个字符串是否为 IP 地址
function isIPAddress(str) {
    if (!str) return false;
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(str.trim());
}

// ================= 内存数据与云端同步 =================

async function initMemoryFromGithub() {
    try {
        const keysUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_KEYS_PATH}`;
        const keysRes = await axios.get(keysUrl, { headers: githubHeaders, timeout: 5000 });
        keysSha = keysRes.data.sha;
        const keysText = Buffer.from(keysRes.data.content, 'base64').toString('utf-8');
        
        keyStore.clear();
        const lines = keysText.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const trimmed = lines[i].trim();
            if (!trimmed) continue;
            const parts = trimmed.split(':');
            const k = parts[0]?.trim();
            if (!k) continue;

            const tag = parts[1]?.trim() || '';
            const p2 = parts[2]?.trim() || '';
            const p3 = parts[3]?.trim() || '';

            if (tag === 'DISABLED') {
                keyStore.set(k, { status: 'DISABLED' });
            } else if (tag === 'BOUND') {
                keyStore.set(k, { status: 'BOUND', hwid: p2, ip: p3 });
            } else if (tag === 'CLAIMED') {
                const claimedAt = p3 ? parseInt(p3, 10) : Date.now();
                keyStore.set(k, { status: 'CLAIMED', ip: p2, claimedAt });
            } else if (tag !== '' && !isIPAddress(tag)) {
                keyStore.set(k, { status: 'BOUND', hwid: tag, ip: p2 });
            } else if (isIPAddress(p2) || isIPAddress(tag)) {
                const ip = isIPAddress(p2) ? p2 : tag;
                keyStore.set(k, { status: 'CLAIMED', ip: ip, claimedAt: Date.now() });
            } else {
                keyStore.set(k, { status: 'EMPTY' });
            }
        }

        console.log(`[初始化成功] 内存加载了 ${keyStore.size} 条卡密`);
    } catch (err) {
        console.error("[初始化失败] 读取 GitHub 异常:", err.message);
    }
}

// 防抖高并发云端同步：避免每次 API 调用都直接打 GitHub 造成卡顿与限流
function scheduleSyncToGithub() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        syncKeysToGithubAsync();
    }, 3000); // 延迟 3 秒统一批量提交写操作
}

async function syncKeysToGithubAsync() {
    if (isSavingKeys) return;
    isSavingKeys = true;
    try {
        const lines = [];
        keyStore.forEach((val, k) => {
            if (val.status === 'DISABLED') {
                lines.push(`${k}:DISABLED`);
            } else if (val.status === 'BOUND') {
                lines.push(`${k}:BOUND:${val.hwid || ''}:${val.ip || ''}`);
            } else if (val.status === 'CLAIMED') {
                lines.push(`${k}:CLAIMED:${val.ip || ''}:${val.claimedAt || Date.now()}`);
            } else {
                lines.push(k);
            }
        });
        const content = lines.join('\n');
        const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_KEYS_PATH}`;
        const payload = { message: "Async sync keys batch", content: Buffer.from(content, 'utf-8').toString('base64'), sha: keysSha };
        const res = await axios.put(url, payload, { headers: githubHeaders });
        if (res.data?.content?.sha) keysSha = res.data.content.sha;
    } catch (e) {
        console.error("[后台保存失败] Keys 同步出问题:", e.message);
    } finally {
        isSavingKeys = false;
    }
}

// ================= 超时回收与清理逻辑 =================

function reclaimUnusedKeys(timeoutMinutes = KEY_TIMEOUT_MINUTES) {
    const now = Date.now();
    const timeoutMs = timeoutMinutes * 60 * 1000;
    let reclaimedCount = 0;

    for (const [k, val] of keyStore.entries()) {
        if (val.status === 'CLAIMED') {
            const claimedTime = val.claimedAt || 0;
            if (now - claimedTime > timeoutMs) {
                keyStore.set(k, { status: 'EMPTY' });
                reclaimedCount++;
            }
        }
    }

    if (reclaimedCount > 0) {
        console.log(`[回收成功] 清理了 ${reclaimedCount} 张超过 ${timeoutMinutes} 分钟未绑定的卡密`);
        scheduleSyncToGithub();
    }
    return reclaimedCount;
}

function forceCleanAllIPKeys() {
    let count = 0;
    for (const [k, val] of keyStore.entries()) {
        if (val.status === 'CLAIMED') {
            keyStore.set(k, { status: 'EMPTY' });
            count++;
        }
    }
    if (count > 0) {
        scheduleSyncToGithub();
    }
    return count;
}

function resetAllKeyBindings() {
    let resetCount = 0;
    for (const [k, val] of keyStore.entries()) {
        if (val.status !== 'EMPTY' && val.status !== 'DISABLED') {
            keyStore.set(k, { status: 'EMPTY' });
            resetCount++;
        }
    }
    if (resetCount > 0) {
        scheduleSyncToGithub();
    }
    return resetCount;
}

// 后台定时任务：自动回收未绑定卡密与清理过期在线玩家
setInterval(() => reclaimUnusedKeys(KEY_TIMEOUT_MINUTES), RECLAIM_CHECK_INTERVAL_MINUTES * 60 * 1000);

setInterval(() => {
    const now = Date.now();
    for (const [user, val] of activeUsers.entries()) {
        if (now - val.lastSeen >= 90000) {
            activeUsers.delete(user);
        }
    }
}, 30000);

// ================= Express Web API 路由 =================
const app = express();
app.set('trust proxy', true);
app.use(express.json());

app.get('/', (req, res) => res.status(200).send({ status: "online", memoryKeys: keyStore.size }));
app.get('/health', (req, res) => res.status(200).send("OK"));

app.get('/api/force-clean-ips', (req, res) => {
    const cleaned = forceCleanAllIPKeys();
    res.send(`<h1>清理成功！共重置了 ${cleaned} 张领卡未绑定的卡密！</h1>`);
});

app.get('/api/reset-all-keys', (req, res) => {
    const secret = req.query.secret;
    if (secret !== AUTH_SECRET) {
        return res.status(403).send("<h1>验证失败：安全密钥错误！</h1>");
    }
    const resetCount = resetAllKeyBindings();
    res.send(`<h1>重置成功！共解绑并重置了 ${resetCount} 张卡密！</h1>`);
});

// 1. 自助领卡 API (/get-key) - 内存极致响应
app.get('/get-key', (req, res) => {
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const timeoutMs = KEY_TIMEOUT_MINUTES * 60 * 1000;

    // 优先匹配已绑定的卡密
    for (const [k, val] of keyStore.entries()) {
        if (val.status === 'BOUND' && val.ip === clientIp) {
            return res.send(`<h2>您已成功绑定设备，您的专属卡密为：</h2><h1 style="color:#0051ff;">${k}</h1>`);
        }
    }

    // 匹配同 IP 10 分钟内领过的卡密（刷新防重复发新卡）
    for (const [k, val] of keyStore.entries()) {
        if (val.status === 'CLAIMED' && val.ip === clientIp) {
            if (val.claimedAt && (now - val.claimedAt <= timeoutMs)) {
                return res.send(`<h2>您已领取过卡密（${KEY_TIMEOUT_MINUTES}分钟内有效，请尽快绑定）：</h2><h1 style="color:#0051ff;">${k}</h1>`);
            }
        }
    }

    // 寻找全新空闲卡密
    let foundKey = null;
    for (const [k, val] of keyStore.entries()) {
        if (val.status === 'EMPTY' && !val.ip && !val.hwid) {
            foundKey = k;
            break;
        }
    }

    if (!foundKey) return res.send("<h2>卡密库存不足！</h2>");

    // 快速写内存，立即响应客户端
    keyStore.set(foundKey, { 
        status: 'CLAIMED', 
        ip: clientIp, 
        claimedAt: Date.now() 
    });
    
    // 异步防抖入库，不阻塞玩家
    scheduleSyncToGithub();

    return res.send(`<h2>您的专属卡密（请在 ${KEY_TIMEOUT_MINUTES} 分钟内绑定）：</h2><h1 style="color:#0051ff;">${foundKey}</h1>`);
});

// 2. 客户端卡密 HWID 验证与绑定 API (/api/bind-hwid) - 极速响应
app.post('/api/bind-hwid', (req, res) => {
    const { key, hwid, secret, username } = req.body;
    if (secret !== AUTH_SECRET) return res.status(403).json({ success: false, message: "密钥错误" });

    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const cleanKey = String(key || '').trim();
    const cleanUser = String(username || '').trim();
    const cleanHwid = String(hwid || '').trim();

    if (!cleanKey || !cleanHwid) return res.status(400).json({ success: false, message: "缺失关键参数" });

    const keyData = keyStore.get(cleanKey);
    if (!keyData) return res.status(404).json({ success: false, message: "卡密不存在或已被删除" });

    if (keyData.status === 'DISABLED') {
        return res.status(403).json({ success: false, message: "该卡密已被管理员封禁" });
    }

    let authPassed = false;
    let msg = "";
    let needSync = false;

    if (keyData.status === 'EMPTY' || keyData.status === 'CLAIMED' || !keyData.status) {
        keyData.status = 'BOUND';
        keyData.hwid = cleanHwid;
        if (clientIp) keyData.ip = clientIp;
        delete keyData.claimedAt;
        authPassed = true;
        needSync = true;
        msg = "首次登录，成功绑定设备";
    } else if (keyData.status === 'BOUND' && keyData.hwid === cleanHwid) {
        authPassed = true;
        msg = "设备比对成功";
    } else {
        authPassed = false;
        msg = "卡密已被其他设备绑定";
    }

    if (!authPassed) return res.status(400).json({ success: false, message: msg });

    if (cleanUser) activeUsers.set(cleanUser, { lastSeen: Date.now(), key: cleanKey, hwid: cleanHwid });

    if (needSync) scheduleSyncToGithub();

    return res.json({ success: true, isAdmin: false, message: msg });
});

// 3. 在线玩家列表
app.get('/api/online-users', (req, res) => {
    const list = Array.from(activeUsers.keys());
    res.json({ success: true, users: list });
});

// 启动服务器
app.listen(PORT, () => {
    console.log(`[服务器已启动] 端口 ${PORT}`);
    initMemoryFromGithub();
});

// ================= Discord 机器人 =================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder().setName('genkey').setDescription('【管理员】批量生成卡密').addIntegerOption(o => o.setName('count').setDescription('数量').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('resetkey').setDescription('【管理员】重置单个卡密绑定设备').addStringOption(o => o.setName('key').setDescription('卡密').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('resetallkeys').setDescription('【管理员】一键解绑所有卡密的设备/IP').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('bankey').setDescription('【管理员】封禁/禁用某个卡密').addStringOption(o => o.setName('key').setDescription('要封禁的卡密').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('unbankey').setDescription('【管理员】解封/恢复某个卡密').addStringOption(o => o.setName('key').setDescription('要解封的卡密').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('delkey').setDescription('【管理员】永久删除卡密').addStringOption(o => o.setName('key').setDescription('卡密').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('reclaim').setDescription('【管理员】清理所有未绑定设备的 IP 卡密').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

client.on('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log("Discord 指令加载完毕");
    } catch (e) {
        console.error("加载 Discord 指令失败:", e);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: "❌ 权限不足！", ephemeral: true });
    }

    const { commandName } = interaction;

    if (commandName === 'genkey') {
        const count = interaction.options.getInteger('count');
        const newKeys = [];
        for (let i = 0; i < count; i++) {
            const k = `XLKEY-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
            keyStore.set(k, { status: 'EMPTY' });
            newKeys.push(k);
        }
        scheduleSyncToGithub();
        return interaction.reply({ content: `✅ 成功生成 **${count}** 张卡密：\n\`\`\`text\n${newKeys.join('\n')}\n\`\`\``, ephemeral: true });
    }

    if (commandName === 'resetkey') {
        const k = interaction.options.getString('key').trim();
        if (!keyStore.has(k)) return interaction.reply({ content: `❌ 未找到卡密 \`${k}\``, ephemeral: true });
        keyStore.set(k, { status: 'EMPTY' });
        scheduleSyncToGithub();
        return interaction.reply({ content: `✅ 卡密 \`${k}\` HWID 绑定已重置`, ephemeral: true });
    }

    if (commandName === 'bankey') {
        const k = interaction.options.getString('key').trim();
        if (!keyStore.has(k)) return interaction.reply({ content: `❌ 未找到卡密 \`${k}\``, ephemeral: true });
        keyStore.set(k, { status: 'DISABLED' });
        scheduleSyncToGithub();
        return interaction.reply({ content: `⛔ 卡密 \`${k}\` 已成功封禁/禁用！`, ephemeral: true });
    }

    if (commandName === 'unbankey') {
        const k = interaction.options.getString('key').trim();
        if (!keyStore.has(k)) return interaction.reply({ content: `❌ 未找到卡密 \`${k}\``, ephemeral: true });
        keyStore.set(k, { status: 'EMPTY' });
        scheduleSyncToGithub();
        return interaction.reply({ content: `✅ 卡密 \`${k}\` 已解封并恢复为未绑定状态！`, ephemeral: true });
    }

    if (commandName === 'resetallkeys') {
        const count = resetAllKeyBindings();
        return interaction.reply({ content: `🧹 **一键全局重置完成！** 共清除 **${count}** 张卡密的设备及 IP 绑定，已被封禁的卡密不受影响。`, ephemeral: true });
    }

    if (commandName === 'delkey') {
        const k = interaction.options.getString('key').trim();
        if (!keyStore.has(k)) return interaction.reply({ content: `❌ 未找到卡密 \`${k}\``, ephemeral: true });
        keyStore.delete(k);
        scheduleSyncToGithub();
        return interaction.reply({ content: `🚨 卡密 \`${k}\` 已销毁删除`, ephemeral: true });
    }

    if (commandName === 'reclaim') {
        const count = forceCleanAllIPKeys();
        return interaction.reply({ content: `🧹 手动清理完成！共强制收回 **${count}** 张领卡未绑定的卡密并已重置投放。`, ephemeral: true });
    }
});

client.login(DISCORD_TOKEN);
