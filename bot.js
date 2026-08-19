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

const ADMIN_KEYS = new Set(["LNMKG-917813", "XQWTU-78918888", "XLKEY-ADMIN888", "XLKEY-ADMIN999", "XiaoLinAdmin666"]);

// 内存极速数据库（使用 Map 实现 O(1) 零循环查找）
// keyStore: Map<Key, { status: string, owner: string }>
const keyStore = new Map();
// banSet: Set<UsernameLowercase>
const banSet = new Set();
// activeUsers: Map<Username, { lastSeen: number, key: string, hwid: string }>
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

// ================= 内存数据与云端同步 =================

// 初始化：将 GitHub 数据一次性加载进内存
async function initMemoryFromGithub() {
    try {
        // 读取 Keys
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
            if (k) {
                keyStore.set(k, { status: parts[1]?.trim() || '', owner: parts[2]?.trim() || '' });
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

// 异步静默持久化到 GitHub（不阻碍客户端 API 响应）
async function syncKeysToGithubAsync() {
    if (isSavingKeys) return;
    isSavingKeys = true;
    try {
        const lines = [];
        keyStore.forEach((val, k) => {
            if (val.status) {
                lines.push(val.owner ? `${k}:${val.status}:${val.owner}` : `${k}:${val.status}`);
            } else {
                lines.push(k);
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

// ================= Express Web API 路由 =================
const app = express();
app.set('trust proxy', true);
app.use(express.json());

app.get('/', (req, res) => res.status(200).send({ status: "online", memoryKeys: keyStore.size }));
app.get('/health', (req, res) => res.status(200).send("OK"));

// 1. 自助领卡 API (网页 /get-key)
app.get('/get-key', (req, res) => {
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    // O(1) 快速检索该 IP 是否领过
    for (const [k, val] of keyStore.entries()) {
        if (val.status === 'CLAIMED' && val.owner === clientIp) {
            return res.send(`<h2>您已领取过卡密：</h2><h1 style="color:#0051ff;">${k}</h1>`);
        }
    }

    // 寻找未使用的卡密
    let foundKey = null;
    for (const [k, val] of keyStore.entries()) {
        if (!val.status) {
            foundKey = k;
            break;
        }
    }

    if (!foundKey) return res.send("<h2>卡密库存不足！</h2>");

    keyStore.set(foundKey, { status: 'CLAIMED', owner: clientIp });
    syncKeysToGithubAsync(); // 异步写入，直接响应网页

    return res.send(`<h2>您的专属卡密：</h2><h1 style="color:#0051ff;">${foundKey}</h1>`);
});

// 2. 客户端卡密 HWID 验证 API (/api/bind-hwid) — 极速响应！
app.post('/api/bind-hwid', (req, res) => {
    const { key, hwid, secret, username } = req.body;
    if (secret !== AUTH_SECRET) return res.status(403).json({ success: false, message: "密钥错误" });

    const cleanKey = String(key || '').trim();
    const cleanUser = String(username || '').trim();
    const cleanHwid = String(hwid || '').trim();

    // 1. 黑名单内存比对 O(1)
    if (cleanUser && banSet.has(cleanUser.toLowerCase())) {
        activeUsers.delete(cleanUser);
        return res.status(403).json({ success: false, kicked: true, message: "玩家已被列入黑名单" });
    }

    // 2. 管理员卡密白名单比对 O(1)
    if (ADMIN_KEYS.has(cleanKey)) {
        if (cleanUser) activeUsers.set(cleanUser, { lastSeen: Date.now(), key: cleanKey, hwid: cleanHwid });
        return res.json({ success: true, isAdmin: true, message: "管理员登录成功！" });
    }

    if (!cleanKey || !cleanHwid) return res.status(400).json({ success: false, message: "缺失关键参数" });

    // 3. 卡密内存比对 O(1) — 零循环！
    const keyData = keyStore.get(cleanKey);
    if (!keyData) return res.status(404).json({ success: false, message: "卡密不存在或已被删除" });

    let authPassed = false;
    let msg = "";
    let needSync = false;

    if (!keyData.status || keyData.status === 'CLAIMED') {
        keyData.status = cleanHwid;
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

    // 异步同步到云端，不耽误客户端毫秒级返回
    if (needSync) syncKeysToGithubAsync();

    return res.json({ success: true, isAdmin: false, message: msg });
});

// 3. 在线玩家列表
app.get('/api/online-users', (req, res) => {
    const now = Date.now();
    const list = [];
    activeUsers.forEach((val, user) => {
        if (now - val.lastSeen < 90000) { // 90秒无心跳判定离线
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

// 5. 远程 Kick 踢人
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

// 6. 远程 Unban 解封
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

// 启动服务器并同步内存
app.listen(PORT, () => {
    console.log(`[服务器已启动] 端口 ${PORT}`);
    initMemoryFromGithub();
});

// ================= Discord 机器人 =================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
    new SlashCommandBuilder().setName('genkey').setDescription('【管理员】批量生成卡密').addIntegerOption(o => o.setName('count').setDescription('数量').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('resetkey').setDescription('【管理员】重置卡密绑定设备').addStringOption(o => o.setName('key').setDescription('卡密').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('delkey').setDescription('【管理员】删除/作废卡密').addStringOption(o => o.setName('key').setDescription('卡密').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('banuser').setDescription('【管理员】拉黑玩家').addStringOption(o => o.setName('username').setDescription('用户名').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('unbanuser').setDescription('【管理员】解封玩家').addStringOption(o => o.setName('username').setDescription('用户名').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
];

client.on('ready', async () => {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log("Discord 指令加载完毕");
    } catch (e) {}
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
});

client.login(DISCORD_TOKEN);
