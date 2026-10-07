@echo off
setlocal EnableExtensions

rem 使用 Git for Windows 的 bash。PATH 里的 bash 多半是 WSL，那里没有 Windows 的 node。
set "BASH="
for /f "delims=" %%G in ('where git 2^>nul') do (
  if not defined BASH if exist "%%~dpG..\bin\bash.exe" set "BASH=%%~dpG..\bin\bash.exe"
)
if not defined BASH if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined BASH if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined BASH if exist "%LOCALAPPDATA%\Programs\Git\bin\bash.exe" set "BASH=%LOCALAPPDATA%\Programs\Git\bin\bash.exe"

if not defined BASH (
  echo Git Bash not found. Install Git for Windows, or run test.sh from Git Bash. 1>&2
  exit /b 127
)

"%BASH%" "%~dp0test.sh" %*
exit /b %ERRORLEVEL%
