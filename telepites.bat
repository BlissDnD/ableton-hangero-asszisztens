@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Hangero-asszisztens telepites ===
where node >nul 2>nul || (echo HIBA: nincs Node.js. Telepitsd: https://nodejs.org ^(LTS^), majd inditsd ujra ezt a fajlt. & pause & exit /b 1)
node --version
echo.
echo 1/2: Remote Script bemasolasa az Ableton User Library-be...
call hangero.cmd telepit
if errorlevel 1 (echo. & echo Nem talaltam a User Library-t. Nezd meg az Abletonban: Preferences ^> Library, majd futtasd parancssorbol: hangero telepit --konyvtar "C:\ut\User Library" & pause & exit /b 1)
echo.
echo Kovetkezo lepesek:
echo  1. Inditsd ujra az Ableton Live-ot.
echo  2. Preferences ^> Link, Tempo ^& MIDI ^> Control Surface: AbletonMCP, Input es Output: None.
echo  3. Nyisd meg a projektet, majd inditsd az ellenorzes.bat-ot.
pause
