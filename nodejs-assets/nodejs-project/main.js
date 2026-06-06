// Minimal test - sadece engine çalışıyor mu kontrol
var rn_bridge = require('rn-bridge');

rn_bridge.channel.send(JSON.stringify({ event: 'engine_ready', data: {} }));

rn_bridge.channel.on('message', function(raw) {
  try {
    var msg = JSON.parse(raw);
    if (msg.action === 'connect') {
      rn_bridge.channel.send(JSON.stringify({ 
        event: 'pairing_code', 
        data: { code: '12345678' } 
      }));
    }
  } catch(e) {}
});
