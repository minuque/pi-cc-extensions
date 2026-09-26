# 本地开发运行器：临时用当前检出的目录替换 npm 安装的扩展，退出后还原成进入前的状态。
# 用法：test.bat [pi 的参数...]
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$PiArgs)

$ErrorActionPreference = 'Stop'

$repoDir = $PSScriptRoot
$npmSource = 'npm:pi-cc-extensions'

# pi 用 PI_CODING_AGENT_DIR 覆盖配置目录，默认 ~/.pi/agent
$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi/agent' }
$settingsPath = Join-Path $agentDir 'settings.json'

function Get-ConfiguredSources {
	if (-not (Test-Path $settingsPath)) { return @() }
	$settings = Get-Content -Raw $settingsPath | ConvertFrom-Json
	@($settings.packages) | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.source } }
}

# 判断某条配置是否指向当前检出目录（本地配置以相对 agentDir 的形式存储）
function Test-LocalSource([string]$source) {
	if ($source -like 'npm:*') { return $false }
	$candidate = if ([IO.Path]::IsPathRooted($source)) { $source } else { Join-Path $agentDir $source }
	(Test-Path $candidate) -and
		([IO.Path]::GetFullPath($candidate) -eq [IO.Path]::GetFullPath($repoDir))
}

$before = @(Get-ConfiguredSources)
$hadNpm = $before -contains $npmSource
$hadLocal = @($before | Where-Object { Test-LocalSource $_ }).Count -gt 0

Push-Location $repoDir
$exitCode = 0
try {
	if ($hadNpm) {
		pi remove $npmSource | Out-Null
		Write-Host "[swap] remove $npmSource"
	}
	pi install $repoDir | Out-Null
	Write-Host "[swap] load local extension $repoDir"
	@(Get-ConfiguredSources) | ForEach-Object { Write-Host "[loaded] $_" }

	& pi @PiArgs
	$exitCode = $LASTEXITCODE
}
finally {
	Pop-Location
	try {
		if (-not $hadLocal) {
			pi remove $repoDir | Out-Null
			Write-Host '[restore] remove temporary local extension'
		}
		if ($hadNpm) {
			pi install $npmSource | Out-Null
			Write-Host "[restore] restore $npmSource"
		}
		Write-Host "[restore] packages: $(@(Get-ConfiguredSources) -join ', ')"
		if (-not ($hadNpm -or $hadLocal)) {
			Write-Host "[restore] note: $npmSource was not configured before; run 'pi install $npmSource' to restore a normal install"
		}
	}
	catch {
		Write-Warning "rollback failed: $_"
		Write-Warning "run manually: pi install $npmSource"
	}
}

exit $exitCode
