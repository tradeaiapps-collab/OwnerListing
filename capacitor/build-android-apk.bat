@echo off
rem Double-click to build a debug APK of the OwnerListing Android shell.
rem Needs: Node 22 and Android Studio (it installs the Android SDK and a JDK).
setlocal
cd /d "%~dp0"

if "%OWNERLISTING_APP_URL%"=="" (
  echo Type the website address the app should open. Example: http://192.168.1.20:3005
  echo ^(Your PC's Wi-Fi address from ipconfig. Not localhost: on the phone that means the phone.^)
  set /p OWNERLISTING_APP_URL=Address: 
)
if "%OWNERLISTING_APP_URL%"=="" ( echo No address given. & goto :fail )

where node >nul 2>&1 || ( echo Node.js not found. Install Node 22 from nodejs.org. & goto :fail )

if "%ANDROID_HOME%"=="" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not exist "%ANDROID_HOME%\platforms" ( echo Android SDK not found at %ANDROID_HOME%. Install Android Studio, open it once and finish setup. & goto :fail )
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"

if "%JAVA_HOME%"=="" if exist "%ProgramFiles%\Android\Android Studio\jbr" set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
if "%JAVA_HOME%"=="" ( echo JDK not found. Install Android Studio ^(includes one^) or set JAVA_HOME. & goto :fail )

set "SDKPROP=%ANDROID_HOME:\=\\%"
set "SDKPROP=%SDKPROP::=\:%"
> android\local.properties echo sdk.dir=%SDKPROP%

call npm install --no-audit --no-fund || goto :fail
call npx cap sync android || goto :fail
pushd android
call gradlew.bat assembleDebug || ( popd & goto :fail )
popd

set "APK=%~dp0android\app\build\outputs\apk\debug\app-debug.apk"
if not exist "%APK%" goto :fail
copy /y "%APK%" "%USERPROFILE%\Desktop\ownerlisting.apk" >nul
echo.
echo Done. APK copied to your Desktop: ownerlisting.apk  ^(opens %OWNERLISTING_APP_URL%^)
pause
exit /b 0

:fail
echo.
echo Build failed. See messages above.
pause
exit /b 1
