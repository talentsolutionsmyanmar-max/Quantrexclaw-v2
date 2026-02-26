import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, Button, ScrollView, Alert, StyleSheet } from 'react-native';
export default function App() {
  const [command, setCommand] = useState('');
  const [mmtTime, setMmtTime] = useState('');
  const [inKillzone, setInKillzone] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      const mmt = new Date(now.getTime() + 6.5*60*60*1000);
      setMmtTime(mmt.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}));
      const h = mmt.getHours() + mmt.getMinutes()/60;
      setInKillzone((6.5<=h&&h<=10)||(13<=h&&h<=17)||(18.25<=h&&h<=22.083));
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  const handlePrep = () => {
    if (!inKillzone) return Alert.alert("NO TRADE", "Waiting for killzone");
    Alert.alert("✅ Data Pack", "Confluence 94 - GO Long SOLUSDT");
  };
  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>🚀 QuentrexClaw v3.5</Text>
      <Text style={styles.mmt}>MMT: {mmtTime} {inKillzone ? '🔥 KILLZONE LIVE' : '⏳ WAITING'}</Text>
      <TextInput style={styles.input} placeholder="QuentrexClaw prep SOLUSDT AKZ" value={command} onChangeText={setCommand} />
      <Button title="ROCK THE PREP" onPress={handlePrep} color="#00ff00" />
    </ScrollView>
  );
}
const styles = StyleSheet.create({ container:{flex:1, padding:20, backgroundColor:'#000'}, title:{fontSize:28, color:'#00ff00', textAlign:'center'}, mmt:{fontSize:18, color:'#ffff00', textAlign:'center'}, input:{borderWidth:2, borderColor:'#00ff00', padding:15, margin:15, color:'#fff'} });
