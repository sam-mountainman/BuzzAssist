# BuzzAssist の1行導入（Windows、管理者権限は不要）
#
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://raw.githubusercontent.com/sam-mountainman/BuzzAssist/main/install.ps1 -OutFile $env:TEMP\buzzassist-install.ps1; & $env:TEMP\buzzassist-install.ps1"
#
# ダウンロード済みのファイルを実行するとき:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#
# 「このシステムではスクリプトの実行が無効になっているため…」と出て止まったときは、
# 実行ポリシーで止められています。上のように -ExecutionPolicy Bypass を付けた powershell で
# 実行してください（その1回の実行だけに効き、端末の設定は変えません）。
#
# やること（何度実行しても同じ結果になる）:
#   1. Node.js 22 以上が無ければ、nodejs.org の公式配布物を SHASUMS256.txt で照合して
#      %USERPROFILE%\.buzzassist\tools\node\ に展開する（システムの Node には触らない）
#   2. 最新の stable Release の tgz を .sha256 で照合して %USERPROFILE%\.buzzassist\app\ に展開する
#   3. 入っているホスト（Claude Code / Codex）を見つけて、見つけた全部へ
#      node scripts\setup-agents.mjs --agents <ホスト> を実行する
#   シンボリックリンクは使わない。
#
# 環境変数（-File で実行したときは引数でも指定できる）:
#   BUZZASSIST_PROJECT_DIR  作業フォルダ（既定 %USERPROFILE%\BuzzAssist）。 -ProjectDir
#   BUZZASSIST_VERSION      入れる版（既定は最新の stable Release）。       -Version
#   BUZZASSIST_SETUP_ARGS   setup-agents にそのまま渡す引数（例: "--no-launch --tunnel"）
#
# このファイルは UTF-8（BOM 付き）で保存している。Windows PowerShell 5.1 が日本語を読み違えないため。

param(
  [string]$ProjectDir = "",
  [string]$Version = "",
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$SetupArgs = @()
)

$ErrorActionPreference = "Stop"
# PowerShell 5.1 の Invoke-WebRequest は進捗表示があると極端に遅い。
$ProgressPreference = "SilentlyContinue"
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$BuzzAssistRepo = if ($env:BUZZASSIST_REPO) { $env:BUZZASSIST_REPO } else { "sam-mountainman/BuzzAssist" }
$NodeMinMajor = 22

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message"
}

function Stop-Install([string]$Message, [string[]]$Details = @()) {
  Write-Host ""
  Write-Host "[BuzzAssist の導入を止めました] $Message" -ForegroundColor Red
  foreach ($line in $Details) { Write-Host "  $line" -ForegroundColor Red }
  throw "BuzzAssist install stopped: $Message"
}

function Get-Download([string]$Url, [string]$OutFile) {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $OutFile -Headers @{ "User-Agent" = "BuzzAssist-installer" }
      return
    } catch {
      if ($attempt -eq 3) { throw }
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
}

function Get-Text([string]$Url) {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers @{ "User-Agent" = "BuzzAssist-installer" }
  if ($response.Content -is [byte[]]) { return [Text.Encoding]::UTF8.GetString($response.Content) }
  return [string]$response.Content
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-NodeMajor([string]$NodeExe) {
  # native command の stderr で止まらないよう、この関数の中だけ Continue（関数の中だけに効く）。
  $ErrorActionPreference = "Continue"
  try {
    $text = & $NodeExe -p "process.versions.node.split('.')[0]" 2>$null
    return [int]$text
  } catch {
    return 0
  }
}

function Expand-ZipArchive([string]$ZipPath, [string]$Destination) {
  # Windows 標準の tar.exe（Windows 10 1803 以降）は zip も展開でき、Expand-Archive よりずっと速い。
  $tar = Join-Path $env:SystemRoot "System32\tar.exe"
  if (Test-Path -LiteralPath $tar) {
    & $tar -xf $ZipPath -C $Destination
    if ($LASTEXITCODE -eq 0) { return }
  }
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $Destination -Force
}

function Install-Node([string]$ToolsDir) {
  Write-Step "Node.js $NodeMinMajor 以上を確認"
  $system = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($system -and (Get-NodeMajor $system.Source) -ge $NodeMinMajor) {
    Write-Host "システムの Node を使います: $($system.Source)"
    return $system.Source
  }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $sumsUrl = "https://nodejs.org/dist/latest-v$NodeMinMajor.x/SHASUMS256.txt"
  try { $sums = Get-Text $sumsUrl } catch { Stop-Install "Node.js の配布一覧（$sumsUrl）を取得できませんでした。" @("ネットワークを確認して、同じコマンドをもう一度実行してください。") }
  $entry = $null
  foreach ($line in ($sums -split "`n")) {
    $parts = $line.Trim() -split "\s+"
    if ($parts.Count -eq 2 -and $parts[1] -match "^node-v[0-9.]+-win-$arch\.zip$") { $entry = $parts; break }
  }
  if (-not $entry) { Stop-Install "Node.js $NodeMinMajor の win-$arch 向け配布物が見つかりませんでした。" }
  $expected = $entry[0].ToLowerInvariant()
  $file = $entry[1]
  $nodeRoot = Join-Path $ToolsDir "node"
  $dir = Join-Path $nodeRoot ($file -replace "\.zip$", "")
  $nodeExe = Join-Path $dir "node.exe"
  if ((Test-Path -LiteralPath $nodeExe) -and (Get-NodeMajor $nodeExe) -ge $NodeMinMajor) {
    Write-Host "入れてある Node を使います: $nodeExe"
    return $nodeExe
  }
  Write-Host "Node.js（$file）を nodejs.org から取得して照合します。"
  New-Item -ItemType Directory -Force -Path $nodeRoot | Out-Null
  $tmp = Join-Path $nodeRoot (".download-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp $file
    try { Get-Download "https://nodejs.org/dist/latest-v$NodeMinMajor.x/$file" $zip } catch { Stop-Install "Node.js（$file）を取得できませんでした。" }
    $actual = Get-Sha256 $zip
    if ($actual -ne $expected) {
      Stop-Install "取得した Node.js の SHA-256 が SHASUMS256.txt と一致しません。" @("期待: $expected", "実際: $actual", "壊れた、または差し替えられた可能性があるので使いません。")
    }
    Expand-ZipArchive $zip $tmp
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    Move-Item -LiteralPath (Join-Path $tmp ($file -replace "\.zip$", "")) -Destination $dir
  } finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Write-Host "Node.js を入れました: $nodeExe"
  return $nodeExe
}

function Resolve-ReleaseVersion([string]$Requested, [string]$NodeExe) {
  Write-Step "最新の stable Release を確認"
  if ($Requested) { return $Requested.TrimStart("v") }
  $tag = ""
  try {
    $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$BuzzAssistRepo/releases/latest" -Headers @{ "User-Agent" = "BuzzAssist-installer" }
    if (-not $release.draft -and -not $release.prerelease) { $tag = [string]$release.tag_name }
  } catch { }
  if (-not $tag) {
    # API の回数制限に当たったとき: /releases/latest の転送先の tag 名を読む。
    try {
      $request = [Net.WebRequest]::Create("https://github.com/$BuzzAssistRepo/releases/latest")
      $request.Method = "HEAD"
      $response = $request.GetResponse()
      $tag = ($response.ResponseUri.AbsolutePath -split "/")[-1]
      $response.Close()
    } catch { }
  }
  $version = $tag.TrimStart("v")
  if ($version -notmatch "^\d+\.\d+\.\d+$") {
    Stop-Install "最新の Release の版を確認できませんでした。" @("ネットワークを確認するか、環境変数 BUZZASSIST_VERSION に 0.1.26 のように版を入れて実行してください。")
  }
  return $version
}

function Install-Release([string]$AppRoot, [string]$Ver, [string]$NodeExe) {
  Write-Step "BuzzAssist $Ver を取得して照合"
  $name = "buzzassist-canvas-mcp-$Ver.tgz"
  $base = "https://github.com/$BuzzAssistRepo/releases/download/v$Ver"
  $app = Join-Path $AppRoot "buzzassist-$Ver"
  $manifest = Join-Path $app "package.json"
  if ((Test-Path -LiteralPath $manifest) -and (Test-Path -LiteralPath (Join-Path $app "scripts\setup-agents.mjs"))) {
    $installed = ""
    try {
      $installed = [string](Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
    } catch { }
    if ($installed -eq $Ver) {
      Write-Host "展開済みの $app を使います。"
      return $app
    }
  }
  $tar = Join-Path $env:SystemRoot "System32\tar.exe"
  if (-not (Test-Path -LiteralPath $tar)) {
    Stop-Install "Windows 標準の tar.exe が見つかりません（Windows 10 1803 以降に入っています）。" @("Windows を更新してから、同じコマンドをもう一度実行してください。")
  }
  New-Item -ItemType Directory -Force -Path $AppRoot | Out-Null
  $tmp = Join-Path $AppRoot (".download-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $archive = Join-Path $tmp $name
    try { Get-Download "$base/$name" $archive } catch { Stop-Install "Release の本体（$name）を取得できませんでした。" }
    try { Get-Download "$base/$name.sha256" "$archive.sha256" } catch { Stop-Install "Release のチェックサム（$name.sha256）を取得できませんでした。" @("照合できないものは入れません。") }
    $expected = ((Get-Content -LiteralPath "$archive.sha256" -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
    $actual = Get-Sha256 $archive
    if ($expected -notmatch "^[0-9a-f]{64}$" -or $expected -ne $actual) {
      Stop-Install "取得した Release の SHA-256 が一致しません。" @("期待: $expected", "実際: $actual", "壊れた、または差し替えられた可能性があるので使いません。")
    }
    & $tar -xzf $archive -C $tmp
    if ($LASTEXITCODE -ne 0) { Stop-Install "Release の展開に失敗しました。" }
    $package = Join-Path $tmp "package"
    if (-not (Test-Path -LiteralPath (Join-Path $package "scripts\setup-agents.mjs"))) { Stop-Install "Release の中身に scripts\setup-agents.mjs がありません。" }
    # npm pack は package-lock.json を入れないので、同梱の lockfile を戻して依存を固定する（自動更新と同じ）。
    $packagedLock = Join-Path $package "release\package-lock.json"
    $lockFile = Join-Path $package "package-lock.json"
    if ((-not (Test-Path -LiteralPath $lockFile)) -and (Test-Path -LiteralPath $packagedLock)) { Copy-Item -LiteralPath $packagedLock -Destination $lockFile }
    if (Test-Path -LiteralPath $app) { Remove-Item -LiteralPath $app -Recurse -Force }
    Move-Item -LiteralPath $package -Destination $app
    Set-Content -LiteralPath (Join-Path $AppRoot "current.txt") -Value $app -Encoding UTF8
  } finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Write-Host "展開しました: $app"
  return $app
}

function Find-Hosts([string]$HomeDir) {
  Write-Step "Claude Code と Codex を探す"
  $hosts = @()
  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claude) {
    $local = Join-Path $HomeDir ".local\bin\claude.exe"
    if (Test-Path -LiteralPath $local) {
      $env:Path = (Split-Path -Parent $local) + ";" + $env:Path
      $claude = $local
    }
  }
  if ($claude) { $hosts += "claude" }
  $codex = $null
  if ($env:CODEX_COMMAND -and (Test-Path -LiteralPath $env:CODEX_COMMAND)) { $codex = $env:CODEX_COMMAND }
  if (-not $codex) { $codex = Get-Command codex -ErrorAction SilentlyContinue }
  if (-not $codex) {
    foreach ($candidate in @(
      $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Programs\ChatGPT\resources\codex.exe" }),
      $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles "ChatGPT\resources\codex.exe" })
    )) {
      if ($candidate -and (Test-Path -LiteralPath $candidate)) { $codex = $candidate; break }
    }
  }
  if ($codex) { $hosts += "codex" }
  if ($hosts.Count -eq 0) {
    Stop-Install "Claude Code も Codex も見つかりませんでした。どちらかを入れてから、同じコマンドをもう一度実行してください。" @(
      "Claude Code: https://docs.anthropic.com/en/docs/claude-code/setup（PowerShell で irm https://claude.ai/install.ps1 | iex）",
      "Codex: ChatGPT デスクトップアプリ https://chatgpt.com/download/ または Codex CLI"
    )
  }
  Write-Host ("見つけたホスト: " + ($hosts -join ","))
  return ($hosts -join ",")
}

function Install-BuzzAssist {
  $homeDir = if ($env:BUZZASSIST_SETUP_HOME) { $env:BUZZASSIST_SETUP_HOME } else { $env:USERPROFILE }
  if (-not $homeDir) { Stop-Install "USERPROFILE が設定されていません。" }
  $toolsDir = if ($env:BUZZASSIST_TOOLS_DIR) { $env:BUZZASSIST_TOOLS_DIR } else { Join-Path $homeDir ".buzzassist\tools" }
  $appRoot = if ($env:BUZZASSIST_APP_DIR) { $env:BUZZASSIST_APP_DIR } else { Join-Path $homeDir ".buzzassist\app" }
  # 作業フォルダの既定: 既に使っている端末では、自動更新の設定に記録された作業フォルダを引き継ぐ
  # （やり直しのためにこのコマンドを打った運営者に、別の空の作業フォルダを作らないため）。
  $previousProject = ""
  $updaterConfig = Join-Path $homeDir ".buzzassist\updater\config.json"
  if (-not $ProjectDir -and -not $env:BUZZASSIST_PROJECT_DIR -and (Test-Path -LiteralPath $updaterConfig)) {
    try {
      $recorded = [string]((Get-Content -LiteralPath $updaterConfig -Raw -Encoding UTF8 | ConvertFrom-Json).projectDir)
      if ($recorded -and (Test-Path -LiteralPath $recorded)) { $previousProject = $recorded }
    } catch { $previousProject = "" }
  }
  $project = if ($ProjectDir) { $ProjectDir } elseif ($env:BUZZASSIST_PROJECT_DIR) { $env:BUZZASSIST_PROJECT_DIR } elseif ($previousProject) { $previousProject } else { Join-Path $homeDir "BuzzAssist" }
  if ($previousProject -and $project -eq $previousProject) { Write-Host "前回の作業フォルダを引き継ぎます: $project" }
  $requested = if ($Version) { $Version } else { [string]$env:BUZZASSIST_VERSION }
  $passthrough = @($SetupArgs | Where-Object { $_ })
  if ($env:BUZZASSIST_SETUP_ARGS) { $passthrough += ($env:BUZZASSIST_SETUP_ARGS -split "\s+" | Where-Object { $_ }) }
  foreach ($arg in $passthrough) {
    if ($arg -in @("--agent", "--agents", "--host")) { Stop-Install "$arg は指定できません。install.ps1 は入っているホストを自動で全部設定します。" }
  }
  # 道具の導入と、有料の本番を回せる準備は別の話（install.sh と同じ理由）。既定では導入を
  # 最後まで終え、足りない準備は「次にやること」として見せる。本番 Job は開始時の doctor が止める。
  $requireReady = ($passthrough -contains "--require-harness-ready") -or ($env:BUZZASSIST_REQUIRE_HARNESS_READY -eq "1")
  $passthrough = @($passthrough | Where-Object { $_ -ne "--require-harness-ready" -and $_ -ne "--allow-harness-not-ready" })
  if (-not $requireReady) { $passthrough += "--allow-harness-not-ready" }

  $nodeExe = Install-Node $toolsDir
  # setup の中の npm と、npm の lifecycle script が同じ Node を使うように。
  $env:Path = (Split-Path -Parent $nodeExe) + ";" + $env:Path
  $ver = Resolve-ReleaseVersion $requested $nodeExe
  Write-Host "入れる版: $ver"
  $app = Install-Release $appRoot $ver $nodeExe
  $hostList = Find-Hosts $homeDir

  Write-Step "setup-agents を実行（$hostList）"
  New-Item -ItemType Directory -Force -Path $project | Out-Null
  $setup = Join-Path $app "scripts\setup-agents.mjs"
  $output = New-Object System.Collections.Generic.List[string]
  # Windows PowerShell 5.1 は、ErrorActionPreference=Stop のまま native command の stderr を 2>&1 で
  # 受けると、最初の1行で止まる。setup の警告（stderr）で導入が止まらないよう、この間だけ Continue にする。
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & $nodeExe $setup --agents $hostList --project-dir $project @passthrough 2>&1 | ForEach-Object {
      $line = [string]$_
      $output.Add($line)
      Write-Host $line
    }
    $status = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  $missing = @($output | Where-Object { $_ -match "^  - [a-z0-9-]+: " } | Select-Object -First 20)
  if ($status -eq 0) {
    Write-Host ""
    Write-Host "BuzzAssist $ver を入れました（$hostList）。Claude Code / Codex を新しく開き直すと使えます。"
    Write-Host "作業フォルダ: $project"
    if (@($output | Where-Object { $_ -match "^BUZZASSIST_HARNESS_READY=no" }).Count -gt 0) {
      Write-Host ""
      Write-Host "【次にやること】キャンバスと画像・動画の道具は使えます。台本から本編を作る前に、次の準備が残っています:"
      foreach ($line in $missing) { Write-Host ("  - " + $line.Trim().TrimStart("-").Trim()) }
      Write-Host "準備ができたかは、作業フォルダで node `"$(Join-Path $app 'scripts\harness-doctor.mjs')`" を実行すると確かめられます。"
      Write-Host "（準備がそろうまで、本番の Job は開始時の点検で止まります。導入の失敗ではありません）"
    }
    return
  }
  if ($status -eq 2) {
    $details = @()
    if ($missing.Count -gt 0) { $details += "足りないもの:"; $details += ($missing | ForEach-Object { $_.Trim() }) }
    $details += "直してから、同じコマンドをもう一度実行してください。準備が残っていても道具だけ先に入れるなら、--require-harness-ready を外して実行します（既定は --allow-harness-not-ready）。"
    Stop-Install "動画ハーネスを回すための前提がまだ足りません（exit 2）。" $details
  }
  Stop-Install "setup-agents が失敗しました（exit $status）。上の出力の最後のエラーを確認してください。" @("ホストの CLI（claude / codex）の導入やログインを直してから、同じコマンドをもう一度実行してください。")
}

Install-BuzzAssist
