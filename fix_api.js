const fs = require('fs');
const file = 'C:/Users/warfa/Documents/GitHub/LinkTime/desktop-agent/webapp/app.js';
let c = fs.readFileSync(file, 'utf8');
const before = (c.match(/fetch\('\/api\//g) || []).length;
c = c.split("fetch('/api/").join("fetch(API_BASE+'/api/");
fs.writeFileSync(file, c);
console.log('Replaced ' + before + ' occurrences');
