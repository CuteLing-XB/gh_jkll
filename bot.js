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
const GITHUB_BAN_PATH = 'blacklist.txt';
const PORT = process.env.PORT || 3000;
const AUTH_SECRET = process.env.AUTH_SECRET || "XiaoLin666";

const KEY_TIMEOUT_MINUTES = 10; // 领卡 10 分钟未绑定自动回收
const RECLAIM_CHECK_INTERVAL_MINUTES = 2; // 每 2 分钟检查一次

const ADMIN_KEYS = new Set(["LNMKG-917813", "XQWTU-78918888", "XLKEY-ADMIN888", "XLKEY-ADMIN999", "XiaoLinAdmin666"]);

// keyStore: Map<Key, { status: string, owner: string, claimedAt?: number }>
const keyStore = new Map();
const banSet = new Set();
const activeUsers = new Map();

let keysSha = null;
let banSha = null;
let isSavingKeys = false;
let isSavingBan = false;

const githubHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'KeyAuth-FastBot'
};

// 判断一个字符串是 HWID 还是纯 IP 地址
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
        keysText.split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;
            const parts = trimmed.split(':');
            const k = parts[0]?.trim();
            if (!k) return;

            let part1 = parts[1]?.trim() || '';
            let part2 = parts[2]?.trim() || '';

            // 情况1: KEY:CLAIMED:IP 或 KEY:HWID:IP
            if (part1 === 'CLAIMED' || isIPAddress(part2)) {
                // 如果没有 HWID 只有 IP，标记为 CLAIMED（并赋予一个初始超时时间，让它能被回收）
                keyStore.set(k, { status: 'CLAIMED', owner: part2 || part1, claimedAt: Date.now() - (KEY_TIMEOUT_MINUTES * 60 * 1000 + 1000) });
            } else if (part1) {
                // 情况2: KEY:HWID (已绑定设备的正常卡)
                keyStore.set(k, { status: part1, owner: part2 });
            } else {
                // 情况3: 纯 KEY (全新未领)
                keyStore.set(k, { status: '', owner: '' });
            }
        });

        // 读取 Blacklist
        const banUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_BAN_PATH}`;
        const banRes = await axios.get(banUrl, { headers: githubHeaders, timeout: 5000 });
        banSha = banRes.data.sha;
        const banText = Buffer.from(banRes.data.content, 'base64').toString('utf-8');

        banSet.clear();
        banText.split(/\r?\n/).forEach(u => {
            if (u.trim()) banSet.add(u.trim().toLowerCase());
        });

        console.log(`[初始化成功] 内存加载了 ${keyStore.size} 条卡密, ${banSet.size} 条黑名单`);
    } catch (err) {
        console.error("[初始化失败] 读取 GitHub 异常:", err.message);
    }
}

async function syncKeysToGithubAsync() {
    if (isSavingKeys) return;
    isSavingKeys = true;
    try {
        const lines = [];
        keyStore.forEach((val, k) => {
            if (val.status === 'CLAIMED') {
                lines.push(`${k}:CLAIMED:${val.owner}`);
            } else if (val.status) {
                lines.push(val.owner ? `${k}:${val.status}:${val.owner}` : `${k}:${val.status}`);
            } else {
                lines.push(k); // 空卡只保留 KEY
            }
        });
        const content = lines.join('\n');
        const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_KEYS_PATH}`;
        const payload = { message: "Async sync keys", content: Buffer.from(content, 'utf-8').toString('base64'), sha: keysSha };
        const res = await axios.put(url, payload, { headers: githubHeaders });
        if (res.data?.content?.sha) keysSha = res.data.content.sha;
    } catch (e) {
        console.error("[后台保存失败] Keys 同步出问题:", e.message);
    } finally {
        isSavingKeys = false;
    }
}

async function syncBanToGithubAsync() {
    if (isSavingBan) return;
    isSavingBan = true;
    try {
        const content = Array.from(banSet).join('\n');
        const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_BAN_PATH}`;
        const payload = { message: "Async sync ban", content: Buffer.from(content, 'utf-8').toString('base64'), sha: banSha };
        const res = await axios.put(url, payload, { headers: githubHeaders });
        if (res.data?.content?.sha) banSha = res.data.content.sha;
    } catch (e) {
        console.error("[后台保存失败] Ban 同步出问题:", e.message);
    } finally {
        isSavingBan = false;
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
                keyStore.set(k, { status: '', owner: '' });
                reclaimedCount++;
            }
        }
    }

    if (reclaimedCount > 0) {
        console.log(`[回收成功] 清理了 ${reclaimedCount} 张超过 ${timeoutMinutes} 分钟未绑定的卡密`);
        syncKeysToGithubAsync();
    }
    return reclaimedCount;
}

// 强制清空【所有】只有 IP 没绑定设备码的废卡
function forceCleanAllIPKeys() {
    let count = 0;
    for (const [k, val] of keyStore.entries()) {
        if (val.status === 'CLAIMED' || isIPAddress(val.status) || isIPAddress(val.owner)) {
            keyStore.set(k, { status: '', owner: '' });
            count++;
        }
    }
    if (count > 0) {
        syncKeysToGithubAsync();
    }
    return count;
}

// 🌟 新增：强制清空【所有卡密】的设备绑定（无论是 HWID 还是 IP）
function resetAllKeyBindings() {
    let resetCount = 0;
    for (const [k, val] of keyStore.entries()) {
        if (val.status !== '' || val.owner !== '') {
            keyStore.set(k, { status: '', owner: '' });
            resetCount++;
        }
    }
    if (resetCount > 0) {
        syncKeysToGithubAsync();
    }
    return resetCount;
}

setInterval(() => reclaimUnusedKeys(KEY_TIMEOUT_MINUTES), RECLAIM_CHECK_INTERVAL_MINUTES * 60 * 1000);

// ================= Express Web API 路由 =================
const app = express();
app.set('trust proxy', true);
app.use(express.json());

app.get('/', (req, res) => res.status(200).send({ status: "online", memoryKeys: keyStore.size }));
app.get('/health', (req, res) => res.status(200).send("OK"));

// 一键清理所有历史 IP 废卡的紧急 API
app.get('/api/force-clean-ips', (req, res) => {
    const cleaned = forceCleanAllIPKeys();
    res.send(`<h1>清理成功！共重置并重新投放了 ${cleaned} 张只有 IP 没有绑定设备码的卡密！GitHub 正在后台更新...</h1>`);
});

// 🌟 一键清空所有卡密设备/HWID绑定的 Web API
// 使用方法: 浏览器访问 http://域名/api/reset-all-keys?secret=XiaoLin666
app.get('/api/reset-all-keys', (req, res) => {
    const secret = req.query.secret;
    if (secret !== AUTH_SECRET) {
        return res.status(403).send("<h1>验证失败：安全密钥错误！</h1>");
    }
    const resetCount = resetAllKeyBindings();
    res.send(`<h1>重置成功！共解绑并重置了 ${resetCount} 张卡密的设备与IP绑定！GitHub 正在后台同步更新...</h1>`);
});

// 1. 自助领卡 API (/get-key)
app.get('/get-key', (req, res) => {
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const timeoutMs = KEY_TIMEOUT_MINUTES * 60 * 1000;

    for (const [k, val] of keyStore.entries()) {
        if (val.status === 'CLAIMED' && val.owner === clientIp) {
            if (val.claimedAt && (now - val.claimedAt <= timeoutMs)) {
                return res.send(`<h2>您已领取过卡密（${KEY_TIMEOUT_MINUTES}分钟内有效，请尽快绑定）：</h2><h1 style="color:#0051ff;">${k}</h1>`);
            }
        }
    }

    reclaimUnusedKeys(KEY_TIMEOUT_MINUTES);

    let foundKey = null;
    for (const [k, val] of keyStore.entries()) {
        if (!val.status) {
            foundKey = k;
            break;
        }
    }

    if (!foundKey) return res.send("<h2>卡密库存不足！</h2>");

    keyStore.set(foundKey, { 
        status: 'CLAIMED', 
        owner: clientIp, 
        claimedAt: Date.now() 
    });
    
    syncKeysToGithubAsync();

    return res.send(`<h2>您的专属卡密（请在 ${KEY_TIMEOUT_MINUTES} 分钟内使用）：</h2><h1 style="color:#0051ff;">${foundKey}</h1>`);
});

// 2. 客户端卡密 HWID 验证 API (/api/bind-hwid)
app.post('/api/bind-hwid', (req, res) => {
    const { key, hwid, secret, username } = req.body;
    if (secret !== AUTH_SECRET) return res.status(403).json({ success: false, message: "密钥错误" });

    const cleanKey = String(key || '').trim();
    const cleanUser = String(username || '').trim();
    const cleanHwid = String(hwid || '').trim();

    if (cleanUser && banSet.has(cleanUser.toLowerCase())) {
        activeUsers.delete(cleanUser);
        return res.status(403).json({ success: false, kicked: true, message: "玩家已被列入黑名单" });
    }

    if (ADMIN_KEYS.has(cleanKey)) {
        if (cleanUser) activeUsers.set(cleanUser, { lastSeen: Date.now(), key: cleanKey, hwid: cleanHwid });
        return res.json({ success: true, isAdmin: true, message: "管理员登录成功！" });
    }

    if (!cleanKey || !cleanHwid) return res.status(400).json({ success: false, message: "缺失关键参数" });

    const keyData = keyStore.get(cleanKey);
    if (!keyData) return res.status(404).json({ success: false, message: "卡密不存在或已被删除" });

    let authPassed = false;
    let msg = "";
    let needSync = false;

    if (!keyData.status || keyData.status === 'CLAIMED') {
        keyData.status = cleanHwid;
        delete keyData.claimedAt;
        authPassed = true;
        needSync = true;
        msg = "首次登录，成功绑定设备";
    } else if (keyData.status === cleanHwid) {
        authPassed = true;
        msg = "设备比对成功";
    } else {
        authPassed = false;
        msg = "卡密已被其他设备绑定";
    }

    if (!authPassed) return res.status(400).json({ success: false, message: msg });

    if (cleanUser) activeUsers.set(cleanUser, { lastSeen: Date.now(), key: cleanKey, hwid: cleanHwid });

    if (needSync) syncKeysToGithubAsync();

    return res.json({ success: true, isAdmin: false, message: msg });
});

// 3. 在线玩家列表
app.get('/api/online-users', (req, res) => {
    const now = Date.now();
    const list = [];
    activeUsers.forEach((val, user) => {
        if (now - val.lastSeen < 90000) {
            list.push(user);
        } else {
            activeUsers.delete(user);
        }
    });
    res.json({ success: true, users: list });
});

// 4. 黑名单列表
app.get('/api/banned-users', (req, res) => {
    res.json({ success: true, users: Array.from(banSet) });
});

// 5. 远程 Kick
app.post('/api/admin-kick', (req, res) => {
    const { adminKey, targetUser, secret } = req.body;
    if (secret !== AUTH_SECRET) return res.status(403).json({ success: false, message: "未授权" });
    if (!ADMIN_KEYS.has(String(adminKey || '').trim())) return res.status(403).json({ success: false, message: "无管理员权限" });

    const target = String(targetUser || '').trim();
    if (!target) return res.status(400).json({ success: false, message: "目标用户名为空" });

    banSet.add(target.toLowerCase());
    activeUsers.delete(target);
    syncBanToGithubAsync();

    res.json({ success: true, message: `已强行拉黑并踢出玩家: [${target}]` });
});

// 6. 远程 Unban
app.post('/api/admin-unban', (req, res) => {
    const { adminKey, targetUser, secret } = req.body;
    if (secret !== AUTH_SECRET) return res.status(403).json({ success: false, message: "未授权" });
    if (!ADMIN_KEYS.has(String(adminKey || '').trim())) return res.status(403).json({ success: false, message: "无管理员权限" });

    const target = String(targetUser || '').trim().toLowerCase();
    if (!banSet.has(target)) return res.status(404).json({ success: false, message: "黑名单中不存在该玩家" });

    banSet.delete(target);
    syncBanToGithubAsync();

    res.json({ success: true, message: `已成功解封玩家: [${targetUser}]` });
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
    new SlashCommandBuilder().setName('resetallkeys').setDescription('【管理员】一键解绑所有卡密的设备/IP').setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // 🌟 新增全局重置指令
    new SlashCommandBuilder().setName('delkey').setDescription('【管理员】删除/作废卡密').addStringOption(o => o.setName('key').setDescription('卡密').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('banuser').setDescription('【管理员】拉黑玩家').addStringOption(o => o.setName('username').setDescription('用户名').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('unbanuser').setDescription('【管理员】解封玩家').addStringOption(o => o.setName('username').setDescription('用户名').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
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
            keyStore.set(k, { status: '', owner: '' });
            newKeys.push(k);
        }
        syncKeysToGithubAsync();
        return interaction.reply({ content: `✅ 成功生成 **${count}** 张卡密：\n\`\`\`text\n${newKeys.join('\n')}\n\`\`\``, ephemeral: true });
    }

    if (commandName === 'resetkey') {
        const k = interaction.options.getString('key').trim();
        if (!keyStore.has(k)) return interaction.reply({ content: `❌ 未找到卡密 \`${k}\``, ephemeral: true });
        keyStore.set(k, { status: '', owner: '' });
        syncKeysToGithubAsync();
        return interaction.reply({ content: `✅ 卡密 \`${k}\` HWID 绑定已解绑`, ephemeral: true });
    }

    // 🌟 新增：处理 /resetallkeys 斜杠指令
    if (commandName === 'resetallkeys') {
        const count = resetAllKeyBindings();
        return interaction.reply({ content: `🧹 **一键全局重置完成！** 共清除 **${count}** 张卡密的设备及 IP 绑定，卡密已全部恢复为未绑定状态。`, ephemeral: true });
    }

    if (commandName === 'delkey') {
        const k = interaction.options.getString('key').trim();
        if (!keyStore.has(k)) return interaction.reply({ content: `❌ 未找到卡密 \`${k}\``, ephemeral: true });
        keyStore.delete(k);
        syncKeysToGithubAsync();
        return interaction.reply({ content: `🚨 卡密 \`${k}\` 已销毁删除`, ephemeral: true });
    }

    if (commandName === 'banuser') {
        const u = interaction.options.getString('username').trim();
        banSet.add(u.toLowerCase());
        activeUsers.delete(u);
        syncBanToGithubAsync();
        return interaction.reply({ content: `⛔ 玩家 \`${u}\` 已加入黑名单！`, ephemeral: true });
    }

    if (commandName === 'unbanuser') {
        const u = interaction.options.getString('username').trim().toLowerCase();
        if (!banSet.has(u)) return interaction.reply({ content: `❌ 黑名单中无 \`${u}\``, ephemeral: true });
        banSet.delete(u);
        syncBanToGithubAsync();
        return interaction.reply({ content: `✅ 玩家 \`${u}\` 已成功解封！`, ephemeral: true });
    }

    if (commandName === 'reclaim') {
        const count = forceCleanAllIPKeys();
        return interaction.reply({ content: `🧹 手动清理完成！共强制收回 **${count}** 张只有 IP 未绑定设备的卡密并已重置投放。`, ephemeral: true });
    }
});

client.login(DISCORD_TOKEN);
