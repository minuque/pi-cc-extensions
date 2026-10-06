@echo off
where pwsh >nul 2>&1 || (
	echo pwsh not found in PATH 1>&2
	exit /b 127
)
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0test.ps1" %*
