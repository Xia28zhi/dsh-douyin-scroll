@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 装 dsh-douyin-scroll（刷抖音）到 DSH

rem ── 用法两种 ──────────────────────────────────────────────
rem  1) 双击：会把「这个 .cmd」「上一级目录」「下载目录、桌面」里
rem           长得像 dsh-douyin-scroll-*.tgz 的包自动找出来
rem  2) 拖拽：把 tgz 直接拖到这个 .cmd 上
rem ─────────────────────────────────────────────────────────

set "HERE=%~dp0"
set "PROFILE=desktop"
set "PKG="

rem ① 拖拽进来的文件优先
if not "%~1"=="" (
  if exist "%~1" set "PKG=%~1"
)

rem ② 依次在这几个地方找最新的 tgz
if not defined PKG call :find "%HERE%"
if not defined PKG call :find "%HERE%..\"
if not defined PKG call :find "%USERPROFILE%\Downloads\"
if not defined PKG call :find "%USERPROFILE%\Desktop\"

if not defined PKG (
  echo [X] 没找到 dsh-douyin-scroll-*.tgz
  echo     把 .cmd 和 tgz 放在同一个目录里再双击，
  echo     或者直接把 tgz 拖到这个 .cmd 上。
  pause & exit /b 1
)

where dsh >nul 2>nul
if errorlevel 1 (
  echo [X] PATH 里没有 dsh。请先在「开始菜单」里打开 DSH 的终端，或用下面的完整命令：
  echo.
  echo     "C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile %PROFILE% add "%PKG%" --registry=https://registry.npmmirror.com
  echo.
  pause & exit /b 1
)

echo 正在装到 profile: %PROFILE%
echo 包: %PKG%
echo.
call dsh plugin --profile %PROFILE% add "%PKG%" --registry=https://registry.npmmirror.com
if errorlevel 1 (
  echo.
  echo [X] 装失败。常见原因：
  echo     1) profile 名字不对 —— 先跑 dsh plugin --profile desktop list 看看
  echo     2) 网络拉不到依赖 —— 确认命令里带了 --registry=https://registry.npmmirror.com
  echo     3) 这个包已经装过了 —— 先 remove 再 add
  pause & exit /b 1
)

echo.
echo [OK] 装好了。**现在重启一次 DSH**（关掉再开），设置里才会出现「刷抖音」。
echo      然后：设置 -^> 刷抖音 -^> 登录抖音（扫码） -^> 测一下 -^> 现在跑一轮。
echo.
pause
exit /b 0

:find
rem %1 = 目录；在里面找最新的 dsh-douyin-scroll-*.tgz
for /f "delims=" %%f in ('dir /b /o-d "%~1dsh-douyin-scroll-*.tgz" 2^>nul') do (
  if not defined PKG set "PKG=%~1%%f"
)
exit /b 0
