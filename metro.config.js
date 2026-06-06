const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 */
const config = {
  resolver: {
    // Node.js modüllerini React Native'de çalıştırmak için
    extraNodeModules: {
      crypto: require.resolve('react-native-crypto'),
      stream: require.resolve('stream-browserify'),
      buffer: require.resolve('buffer'),
      events: require.resolve('events'),
      process: require.resolve('process/browser'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
