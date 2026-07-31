import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'za.co.mokoena.tms',
  appName: 'Kruis Court',
  webDir: 'dist',
  android: {
    // Release builds must never trust cleartext, so the API has to be HTTPS.
    allowMixedContent: false,
  },
  plugins: {
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
