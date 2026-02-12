const { app, BrowserWindow, Tray, Menu, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

// Конфигурация
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const WS_URL = 'wss://linktime.onrender.com';
const SITE_URL = 'https://bzden4ik.github.io/LinkTime/';

// Состояние приложения
let mainWindow = null;
let settingsWindow = null;
let tray = null;
let ws = null;
let config = {
    sessionKey: '',
    checkInterval: 5000,
    idleTimeout: 30000,
    whiteList: [
        'LinkTime',
        'Visual Studio Code',
        'Code.exe',
        'Terminal',
        'cmd.exe',
        'PowerShell',
        'Figma',
        'Adobe Photoshop',
        'Sublime Text',
        'WebStorm',
        'PyCharm',
        'IntelliJ IDEA',
        'Eclipse',
        'Postman',
        'Docker',
        'Git',
        'GitHub Desktop'
    ],
    blackList: [
        'YouTube',
        'Netflix',
        'Facebook',
        'Twitter',
        'Instagram',
        'TikTok',
        'Reddit',
        'Twitch',
        'Steam',
        'Discord - ',
