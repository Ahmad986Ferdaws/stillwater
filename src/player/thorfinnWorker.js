import { sculptThorfinn, transferList } from './thorfinnSculpt.js';

// Sculpting Thorfinn takes a few seconds of maths; doing it here keeps the game running meanwhile.
const data = sculptThorfinn();
self.postMessage(data, transferList(data));
