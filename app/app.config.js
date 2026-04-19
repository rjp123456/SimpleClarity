export default {
  expo: {
    name: "Clarity Lite",
    slug: "clarity-lite",
    scheme: "claritylite",
    version: "1.0.0",
    orientation: "portrait",
    userInterfaceStyle: "light",
    ios: {
      supportsTablet: false
    },
    plugins: ["expo-camera", "expo-location", "expo-notifications"],
    extra: {
      backendUrl: process.env.EXPO_PUBLIC_BACKEND_URL || "",
      easProjectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID || ""
    }
  }
};
