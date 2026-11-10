// Saját szerkezeti ujjlenyomat a describe_set kimenetből.
// Az upstream "fingerprint" a sávok hangerejét/panját/mute-ját is tartalmazza, ezek viszont
// automatizáláskor lejátszás közben maguktól változnak, így hamis "módosult a projekt" riasztást adnának.
// Itt csak a szerkezetet hasheljük: sávok, nevek, típusok, csoportok, eszközök, arm, solo, locatorok.
import crypto from 'node:crypto';

const trackPart = (t) => ({ address: t.address, name: t.name, kind: t.kind, group: t.group ?? null, devices: t.devices ?? [], arm: Boolean(t.arm), solo: Boolean(t.solo) });

export function structuralFingerprint(set) {
  const body = {
    tracks: (set.tracks ?? []).map(trackPart),
    returns: (set.returns ?? []).map(trackPart),
    master: set.master ? { devices: set.master.devices ?? [] } : null,
    cues: (set.cue_points ?? []).map((c) => [c.name, c.time])
  };
  return crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16);
}
