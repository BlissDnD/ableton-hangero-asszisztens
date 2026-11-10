// Szimulált "Ableton" indítása a 9877-es porton, hogy az eszközt Ableton nélkül ki lehessen próbálni.
// FIGYELEM: ez NEM Ableton. Csak a parancssori eszköz kipróbálására való.
import { MockLive } from './mock-live.js';

const port = Number(process.argv[2] || 9877);
const mock = new MockLive({ speed: 1, startBeat: 40 });
await mock.listen(port);
mock.play(40);
console.log(`Szimulált Live fut a ${port}-es porton, a lejátszás a 11. ütemnél indult. Leállítás: Ctrl+C.`);
process.on('SIGINT', () => { mock.stop(); process.exit(0); });
