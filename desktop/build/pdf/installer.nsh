; Riyeser PDF: the "Riyeser PDF" sub-menu in File Explorer's right-click menu, for PDFs and pictures.
; For this Windows user only (HKCU\Software\Classes), so no administrator permission is needed. The uninstaller
; removes it. (An update runs the old uninstaller, then this again, so the menu always points at the new copy.)
; The entries must match MENU in src/pdf/args.js: test/pdf-handy.test.js checks they do.
; On Windows 11 the menu is under "Show more options" (Windows keeps its new short menu for its own entries).
; MultiSelectModel=Document: with several files selected, Windows starts Riyeser PDF once per file (up to 15); the
; copies hand their files to the first one, which gathers them into one job (Combine selected combines them all).

!macro riyeserPdfMenuEntry EXT KEY LABEL TASK
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\RiyeserPDF\shell\${KEY}" "MUIVerb" "${LABEL}"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\RiyeserPDF\shell\${KEY}" "MultiSelectModel" "Document"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\RiyeserPDF\shell\${KEY}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --task=${TASK} "%1"'
!macroend

!macro riyeserPdfMenu EXT
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\RiyeserPDF" "MUIVerb" "Riyeser PDF"
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\RiyeserPDF" "Icon" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\SystemFileAssociations\${EXT}\shell\RiyeserPDF" "SubCommands" ""
!macroend

!macro customInstall
  !insertmacro riyeserPdfMenu ".pdf"
  !insertmacro riyeserPdfMenuEntry ".pdf" "1open" "Open" "open"
  !insertmacro riyeserPdfMenuEntry ".pdf" "2sign" "Sign" "sign"
  !insertmacro riyeserPdfMenuEntry ".pdf" "3compress" "Compress" "compress"
  !insertmacro riyeserPdfMenuEntry ".pdf" "4combine" "Combine selected" "combine"
  !insertmacro riyeserPdfMenuEntry ".pdf" "5toimages" "Convert to images" "toimages"
  !insertmacro riyeserPdfMenu ".jpg"
  !insertmacro riyeserPdfMenuEntry ".jpg" "4combine" "Combine selected" "combine"
  !insertmacro riyeserPdfMenuEntry ".jpg" "6topdf" "Convert to PDF" "topdf"
  !insertmacro riyeserPdfMenu ".jpeg"
  !insertmacro riyeserPdfMenuEntry ".jpeg" "4combine" "Combine selected" "combine"
  !insertmacro riyeserPdfMenuEntry ".jpeg" "6topdf" "Convert to PDF" "topdf"
  !insertmacro riyeserPdfMenu ".png"
  !insertmacro riyeserPdfMenuEntry ".png" "4combine" "Combine selected" "combine"
  !insertmacro riyeserPdfMenuEntry ".png" "6topdf" "Convert to PDF" "topdf"
  ; tell File Explorer the menus changed
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.pdf\shell\RiyeserPDF"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.jpg\shell\RiyeserPDF"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.jpeg\shell\RiyeserPDF"
  DeleteRegKey HKCU "Software\Classes\SystemFileAssociations\.png\shell\RiyeserPDF"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
