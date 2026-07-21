// Platform facts — the Node mirror of LodestoneCore's `Platform`. Centralizes every
// place the launch differs by OS so the rest of the engine stays platform-agnostic.
function hostPlatform() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}
function hostArch() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "ia32") return "x86";
  return "x86_64"; // node "x64"
}

const PLATFORM = hostPlatform();
const ARCH = hostArch();

module.exports = {
  PLATFORM,
  ARCH,
  // Mojang version-JSON rules use "osx" for macOS.
  mojangOSName: PLATFORM === "macos" ? "osx" : PLATFORM,
  classpathSep: PLATFORM === "windows" ? ";" : ":",
  javaBinaryRelativePath:
    PLATFORM === "macos" ? "jre.bundle/Contents/Home/bin/java"
    : PLATFORM === "windows" ? "bin/java.exe"
    : "bin/java",

  javaRuntimeKey() {
    if (PLATFORM === "windows") return ARCH === "arm64" ? "windows-arm64" : "windows-x64";
    if (PLATFORM === "macos") return ARCH === "arm64" ? "mac-os-arm64" : "mac-os";
    return ARCH === "x86" ? "linux-i386" : "linux";
  },

  // The LWJGL natives classifier Mojang ships for this OS+arch.
  nativesClassifier() {
    if (PLATFORM === "windows") return ARCH === "arm64" ? "natives-windows-arm64" : "natives-windows";
    if (PLATFORM === "macos") return ARCH === "arm64" ? "natives-macos-arm64" : "natives-macos";
    return "natives-linux";
  },
};
