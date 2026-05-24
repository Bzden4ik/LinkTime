# ============================================================================
# LinkTime Desktop Agent — one-shot builder
# ----------------------------------------------------------------------------
# Запусти из PowerShell:
#     cd C:\Users\warfa\Downloads\LinkTime\desktop-agent
#     .\build.ps1
#
# Параметры:
#   .\build.ps1 -SkipSync   — не синкать webapp/ из public/
#   .\build.ps1 -Clean      — удалить dist/ и node_modules перед сборкой
# ============================================================================

[CmdletBinding()]
param(
    [switch]$SkipSync,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

# Force UTF-8 console output so emoji/cyrillic render correctly in Win PS 5.1
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

# --- pretty output ----------------------------------------------------------
function Step($msg)  { Write-Host ("`n>> " + $msg) -ForegroundColor Cyan }
function Ok($msg)    { Write-Host ("  [OK]   " + $msg) -ForegroundColor Green }
function Warn($msg)  { Write-Host ("  [WARN] " + $msg) -ForegroundColor Yellow }
function Die($msg)   { Write-Host ("  [FAIL] " + $msg) -ForegroundColor Red; exit 1 }

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $Root
$PublicDir = Join-Path $RepoRoot 'public'
$WebappDir = Join-Path $Root 'webapp'
$DistDir = Join-Path $Root 'dist'

Write-Host ("Project:  " + $Root) -ForegroundColor DarkGray
Write-Host ("Public:   " + $PublicDir) -ForegroundColor DarkGray

# ============================================================================
Step '1/5 - Проверка окружения'

try {
    $nodeVer = (node -v) 2>$null
    if (-not $nodeVer) { throw }
    Ok ("Node " + $nodeVer)
} catch {
    Die 'Node.js не найден. Установи: https://nodejs.org/'
}

try {
    $npmVer = (npm -v) 2>$null
    if (-not $npmVer) { throw }
    Ok ("npm " + $npmVer)
} catch {
    Die 'npm не найден'
}

$Pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
Ok ("Версия в package.json: " + $Pkg.version)

# ============================================================================
Step '2/5 - Синхронизация webapp/ из public/'

if ($SkipSync) {
    Warn 'Пропускаю sync (-SkipSync)'
} else {
    if (-not (Test-Path $PublicDir)) {
        Warn ("Нет " + $PublicDir + " - пропускаю sync. webapp/ останется как есть.")
    } else {
        if (-not (Test-Path $WebappDir)) {
            New-Item -ItemType Directory -Path $WebappDir | Out-Null
        }

        $syncItems = @('index.html', 'app.js', 'style.css', 'board.html', 'manifest.json', 'sw.js')
        foreach ($f in $syncItems) {
            $src = Join-Path $PublicDir $f
            if (Test-Path $src) {
                Copy-Item $src $WebappDir -Force
                Ok ("  " + $f)
            } else {
                Warn ("  " + $f + " нет в public/ - пропускаю")
            }
        }

        $iconsSrc = Join-Path $PublicDir 'icons'
        if (Test-Path $iconsSrc) {
            $iconsDst = Join-Path $WebappDir 'icons'
            if (-not (Test-Path $iconsDst)) {
                New-Item -ItemType Directory -Path $iconsDst | Out-Null
            }
            Copy-Item (Join-Path $iconsSrc '*') $iconsDst -Force -Recurse
            Ok '  icons/'
        }

        Ok 'Webapp синхронизирован'
    }
}

# ============================================================================
Step '3/5 - npm зависимости'

if ($Clean -and (Test-Path (Join-Path $Root 'node_modules'))) {
    Warn 'Удаляю node_modules (-Clean)'
    Remove-Item (Join-Path $Root 'node_modules') -Recurse -Force
}

if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
    Write-Host '  Запускаю npm install (1-2 минуты)...' -ForegroundColor DarkGray
    Push-Location $Root
    try {
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            Die 'npm install упал. Попробуй: .\build.ps1 -Clean'
        }
    } finally {
        Pop-Location
    }
    Ok 'Зависимости установлены'
} else {
    Ok 'node_modules уже на месте (используй -Clean для переустановки)'
}

# ============================================================================
Step '4/5 - electron-builder (Windows / NSIS)'

if ($Clean -and (Test-Path $DistDir)) {
    Warn 'Удаляю dist/ (-Clean)'
    Remove-Item $DistDir -Recurse -Force
}

Write-Host '  Первая сборка - 2-5 минут (качается Electron ~200MB)' -ForegroundColor DarkGray
Write-Host '  Последующие - секунды.' -ForegroundColor DarkGray
Write-Host ''

Push-Location $Root
try {
    & npm run build-win
    if ($LASTEXITCODE -ne 0) {
        Die ('electron-builder вышел с кодом ' + $LASTEXITCODE)
    }
} finally {
    Pop-Location
}

# ============================================================================
Step '5/5 - Результат'

if (-not (Test-Path $DistDir)) {
    Die 'dist/ не создан - что-то пошло не так'
}

$installer = Get-ChildItem $DistDir -Filter 'LinkTime.Setup.v*.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $installer) {
    Warn 'Установщик .exe не найден в dist/. Содержимое:'
    Get-ChildItem $DistDir | ForEach-Object { Write-Host ('    ' + $_.Name) }
    exit 1
}

$sizeMB = [math]::Round($installer.Length / 1MB, 1)
$ver = $Pkg.version
$exePath = $installer.FullName

Write-Host ''
Write-Host '===============================================================' -ForegroundColor Green
Write-Host '  Сборка готова' -ForegroundColor Green
Write-Host ''
Write-Host ('  Файл:   ' + $exePath) -ForegroundColor Cyan
Write-Host ('  Размер: ' + $sizeMB + ' MB')
Write-Host ('  Версия: v' + $ver)
Write-Host ''
Write-Host '  Что дальше:' -ForegroundColor DarkGray
Write-Host '    1. Дважды кликни по .exe - поставится как обычное приложение'
Write-Host '    2. Откроется, подключится к https://linktime.go-tit.ru'
Write-Host '    3. Залить .exe на GitHub Releases для auto-update:'
$ghCmd = 'gh release create v' + $ver + ' "' + $exePath + '"'
Write-Host ('       ' + $ghCmd)
Write-Host '===============================================================' -ForegroundColor Green

Start-Process explorer.exe $DistDir
