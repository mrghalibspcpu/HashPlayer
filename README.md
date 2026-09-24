# HashPlayer — GitHub APK Build Project

## IMPORTANT
After extracting this ZIP, upload the CONTENTS of this folder to the ROOT of the
`mrghalibspcpu/HashPlayer` GitHub repository. Do not upload only the ZIP file.

The repository root must contain:
- `.github/workflows/build-apk.yml`
- `app/`
- `build.gradle`
- `settings.gradle`
- `gradle.properties`

## Build
Open GitHub → HashPlayer → Actions → Build HashPlayer APK → Run workflow.

When the workflow finishes:
Actions → the completed run → Artifacts → `HashPlayer-debug-apk`

The APK is `app-debug.apk`.

## Current native layer
The project contains:
- Android WebView shell
- Android 13+ READ_MEDIA_AUDIO / READ_MEDIA_VIDEO permission declarations
- MediaStore audio/video query
- background scan
- JavaScript bridge entry point
- supplied HashPlayer HTML and icon
- GitHub Actions APK build

Note: the existing HTML needs its library/favorites UI wired to the native bridge before
the native scan can fully replace the browser-only file/folder picker. This ZIP is a
buildable native project, not a claim that every requested production feature has
already been device-tested.
