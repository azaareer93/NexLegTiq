// Self-hosted fonts (D-088): the apps' bundler copies these woff2 files into their own assets, so no font CDN is contacted
// at runtime. Only the Arabic subset of IBM Plex Sans Arabic is loaded; Latin text uses Inter.
import '@fontsource-variable/inter';
import '@fontsource/ibm-plex-sans-arabic/arabic-400.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-500.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-600.css';
import '@fontsource/ibm-plex-sans-arabic/arabic-700.css';
