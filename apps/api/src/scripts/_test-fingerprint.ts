import { buildTextFingerprint } from "../domain/fingerprint.js";

const cases = [
  ["Pope Leo XIV names Archbishop Caccia papal ambassador to United States",
   "Pope Leo XIV has named Archbishop Gabriele Caccia as the Vatican's ambassador to the United States, selecting a seasoned diplomat to serve as a crucial liaison between Rome and the pope's home country.",
   null],
  ["short", "tiny summary", "x"],
  ["A welcome to new Catholics",
   "This year, the Archdiocese of Atlanta is welcoming new Catholics into the church. Read all about it here for inspiration.",
   "This year, the Archdiocese of Atlanta is welcoming new Catholics into the church. Read all about it here for inspiration."],
];
for (const [title, sum, snip] of cases) {
  const fp = buildTextFingerprint(title, sum, snip);
  const len = (title ?? "").length + (sum ?? "").length + (snip ?? "").length;
  console.log(`len=${len} fp=${fp ? fp.slice(0,12) : "null"}  title="${(title??"").slice(0,40)}"`);
}
