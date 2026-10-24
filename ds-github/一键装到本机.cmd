@echo off
chcp 65001 >nul
setlocal
title 装 dsh-douyin-scroll（刷抖音）到 DSH

set "HERE=%~dp0"
set "PKG=%HERE%dsh-douyin-scroll-1.4.14.tgz"
set "PROFILE=desktop"

if not exist "%PKG%" (
  echo [X] 找不到 %PKG%
  echo     把这个 .cmd 和 tgz 放在同一个目录里再双击。
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
  pause & exit /b 1
)

echo.
echo [OK] 装好了。**现在重启一次 DSH**（关掉再开），设置里才会出现「刷抖音」。
echo      然后：设置 -> 刷抖音 -> 登录抖音（扫码） -> 测一下 -> 现在跑一轮。
echo.
pause
