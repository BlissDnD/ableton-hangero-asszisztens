@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Zenerész vizsgálata (csak olvas, semmit nem módosít) ===
echo.
set /p SZEREP=Mi a resz szerepe? (pl. lagy verze / eros refren): 
echo.
echo Most inditsd el a lejatszast az Abletonban a vizsgalt resz elott, hagyd futni, majd allitsd le.
echo.
call hangero.cmd vizsgal --szerep "%SZEREP%" --max-masodperc 90
echo.
echo A jelentes a "jelentesek" mappaban van (.md es .json). Masold be ide a chatbe az .md tartalmat.
pause
