import React from 'react';
import { StatusBar, LogBox, Text } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import HomeScreen from './src/screens/HomeScreen';
import ModerationScreen from './src/screens/ModerationScreen';
import MessagesScreen from './src/screens/MessagesScreen';
import LogsScreen from './src/screens/LogsScreen';
import SettingsScreen from './src/screens/SettingsScreen';

LogBox.ignoreAllLogs();

const Tab = createBottomTabNavigator();

const App = () => {
  return (
    <NavigationContainer
      theme={{
        dark: true,
        colors: {
          primary: '#00a884',
          background: '#111b21',
          card: '#1f2c33',
          text: '#e9edef',
          border: '#2a3942',
          notification: '#ea0038',
        },
      }}>
      <StatusBar barStyle="light-content" backgroundColor="#111b21" />
      <Tab.Navigator
        screenOptions={{
          tabBarStyle: { backgroundColor: '#1f2c33', borderTopColor: '#2a3942', height: 58, paddingBottom: 6 },
          tabBarActiveTintColor: '#00a884',
          tabBarInactiveTintColor: '#8696a0',
          headerStyle: { backgroundColor: '#202c33', elevation: 0 },
          headerTintColor: '#e9edef',
        }}>
        <Tab.Screen name="Ana Sayfa" component={HomeScreen}
          options={{ tabBarIcon: () => <Text style={{ fontSize: 20 }}>🏠</Text>, headerTitle: '⚙️ WhatsApp Grup Yönetici' }} />
        <Tab.Screen name="Moderasyon" component={ModerationScreen}
          options={{ tabBarIcon: () => <Text style={{ fontSize: 20 }}>🛡️</Text> }} />
        <Tab.Screen name="Mesajlar" component={MessagesScreen}
          options={{ tabBarIcon: () => <Text style={{ fontSize: 20 }}>✉️</Text> }} />
        <Tab.Screen name="Loglar" component={LogsScreen}
          options={{ tabBarIcon: () => <Text style={{ fontSize: 20 }}>📋</Text> }} />
        <Tab.Screen name="Ayarlar" component={SettingsScreen}
          options={{ tabBarIcon: () => <Text style={{ fontSize: 20 }}>⚙️</Text> }} />
      </Tab.Navigator>
    </NavigationContainer>
  );
};

export default App;
