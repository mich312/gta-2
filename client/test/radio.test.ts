import { describe, expect, it } from 'vitest';
import audioSpec from 'shared/data/audio.json';
import { stationFor } from '../src/audio/audio.js';

const spec = audioSpec as unknown as {
  radio: { stations: Array<{ name: string }>; emergencyStation: number };
};

describe('car radio (I2)', () => {
  it('a car keeps its station, and two people in it hear the same thing', () => {
    // Nothing about the station crosses the wire: it is a pure function of
    // the vehicle id, so every client agrees without being told.
    for (const id of [1, 2, 17, 512, 99999]) {
      expect(stationFor(id, 'car')).toBe(stationFor(id, 'car'));
    }
  });

  it('different cars are tuned to different things', () => {
    const seen = new Set<number>();
    for (let id = 1; id < 200; id++) seen.add(stationFor(id, 'car'));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('every station a car can be tuned to actually exists', () => {
    for (let id = 1; id < 500; id++) {
      const s = stationFor(id, 'car');
      expect(spec.radio.stations[s]).toBeDefined();
      // Ordinary traffic never lands on the dispatch band.
      expect(s).not.toBe(spec.radio.emergencyStation);
    }
  });

  it('emergency vehicles get the dispatch band, as the original did', () => {
    for (const kind of ['copcar', 'ambulance', 'firetruck']) {
      expect(stationFor(7, kind)).toBe(spec.radio.emergencyStation);
    }
    expect(stationFor(7, 'taxi')).not.toBe(spec.radio.emergencyStation);
  });
});
