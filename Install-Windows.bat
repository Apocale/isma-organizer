@echo off
setlocal EnableExtensions
rem Isma Organizer: installer for Windows.
rem Copies the panel into your Adobe extensions folder, lets Premiere load
rem panels that are not signed (PlayerDebugMode), and checks for ffmpeg.
rem No admin rights. Nothing outside your user profile is changed.
rem Plain ASCII, CRLF line endings, no text inside ( ) blocks: cmd.exe misreads
rem the rest (a ")" in a folder name closes a block early).
title Isma Organizer - install
cls
echo ISMA ORGANIZER: install for Premiere Pro (Windows)
echo.

set "SRC=%~dp0PremiereProOrganizer"
set "CEP=%APPDATA%\Adobe\CEP\extensions"
set "DEST=%APPDATA%\Adobe\CEP\extensions\PremiereProOrganizer"

if exist "%SRC%\CSXS\manifest.xml" goto found
rem Opened from inside the ZIP: Windows runs this file alone from a temp folder.
echo "%~dp0" | find /I ".zip" >nul
if not errorlevel 1 goto zipped
echo [!] The PremiereProOrganizer folder is not next to this installer.
echo     Le dossier PremiereProOrganizer n'est pas a cote de cet installateur.
echo     Unzip the whole download, then run the installer from that folder.
echo     Decompresse tout le telechargement, puis lance l'installateur depuis ce dossier.
goto fail

:zipped
echo [!] The installer was opened from inside the ZIP.
echo     L'installateur a ete ouvert depuis l'interieur du ZIP.
echo     Right-click the ZIP, choose Extract All, then run the installer from the new folder.
echo     Clic droit sur le ZIP, Extraire tout, puis lance l'installateur depuis le nouveau dossier.
goto fail

:found
rem Premiere reads its panels when it starts.
:checkppro
tasklist /NH 2>nul | find /I "Adobe Premiere Pro" >nul
if errorlevel 1 goto closed
echo [!] Premiere Pro is open. Close it first.
echo     Premiere Pro est ouvert. Ferme-le d'abord.
choice /C RI /N /M "Press R to check again, I to install anyway - R pour reverifier, I pour installer quand meme: "
if errorlevel 2 goto closed
goto checkppro

:closed
if not exist "%CEP%" mkdir "%CEP%"
if not exist "%CEP%" goto failcopy

rem Unzipped straight into Adobe's folder: deleting the old copy would delete this one.
if /I "%SRC%"=="%DEST%" goto inplace
if exist "%DEST%" rmdir /s /q "%DEST%"
xcopy "%SRC%" "%DEST%" /E /I /Q /Y >nul
if errorlevel 1 goto failcopy
rem Development files, not needed inside Premiere
if exist "%DEST%\tests" rmdir /s /q "%DEST%\tests"
if exist "%DEST%\tools" rmdir /s /q "%DEST%\tools"
if exist "%DEST%\__pycache__" rmdir /s /q "%DEST%\__pycache__"
echo [OK] Panel copied to "%DEST%"
echo      Panneau copie.
goto copied

:inplace
echo [OK] The panel is already in Adobe's extensions folder.
echo      Le panneau est deja dans le dossier des extensions d'Adobe.

:copied
rem Before 2.6.0, the B-roll tab was a separate panel.
if not exist "%CEP%\PinterestBroll" goto noold
rmdir /s /q "%CEP%\PinterestBroll"
echo [OK] Removed the old Pinterest B-roll panel, now the B-roll tab.
echo      Ancien panneau Pinterest B-roll retire, c'est maintenant l'onglet B-roll.
:noold

rem Another copy under another folder name: Premiere would load one of the two.
for /D %%D in ("%CEP%\*") do call :dupe "%%~fD"

rem Panels that are not signed load only with PlayerDebugMode, one setting per
rem CEP version: 9 = Premiere 2020, 12 = Premiere 2025 and 2026, and a few ahead.
for %%V in (9 10 11 12 13 14 15 16) do reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
echo [OK] Premiere can load panels that are not signed - PlayerDebugMode.
echo      Premiere peut charger les panneaux non signes.

rem ffmpeg saves most Pinterest videos: picture and sound come separately.
rem A few of the places the panel looks.
set "FF="
if exist "%DEST%\bin\ffmpeg.exe" set "FF=1"
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\ffmpeg.exe" set "FF=1"
if exist "C:\ffmpeg\bin\ffmpeg.exe" set "FF=1"
where ffmpeg >nul 2>&1
if not errorlevel 1 set "FF=1"
echo.
if defined FF goto ffok
echo [i] Optional: ffmpeg is not installed. The B-roll tab needs it to save most Pinterest videos.
echo     Facultatif : ffmpeg n'est pas installe. L'onglet B-roll en a besoin pour la plupart des videos Pinterest.
echo     To install it, open a terminal and type:  winget install -e --id Gyan.FFmpeg
echo     Pour l'installer, ouvre un terminal et tape :  winget install -e --id Gyan.FFmpeg
goto ffdone
:ffok
echo [OK] ffmpeg found.
echo      ffmpeg trouve.
:ffdone

echo.
echo Done. Open Premiere Pro, then Window ^> Extensions ^> Isma Organizer.
echo C'est fini. Ouvre Premiere Pro, puis Fenetre ^> Extensions ^> Isma Organizer.
echo.
pause
exit /b 0

:failcopy
echo [!] The copy failed. Is the disk full, or a file still open?
echo     La copie a echoue. Le disque est-il plein, ou un fichier encore ouvert ?
:fail
echo.
pause
exit /b 1

:dupe
if /I "%~1"=="%DEST%" goto :eof
if not exist "%~1\CSXS\manifest.xml" goto :eof
findstr /L /C:"com.OrganizeFilesInProject.panel" "%~1\CSXS\manifest.xml" >nul 2>&1
if errorlevel 1 goto :eof
echo [!] Another copy of this panel is installed: "%~1"
echo     Delete that folder, or Premiere may load the old one.
echo     Supprime ce dossier, sinon Premiere risque de charger l'ancienne copie.
goto :eof
