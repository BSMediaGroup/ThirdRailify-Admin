import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePlatform, providerPlatforms } from '../src/gaming/platforms.ts';
test('IGDB platform names normalize to public icon labels while unknown platforms remain truthful',()=>{
for(const [input,expected] of [['PC (Microsoft Windows)','PC'],['Super Nintendo Entertainment System (SNES)','SNES'],['Nintendo Switch','Nintendo Switch'],['PlayStation 4','PlayStation 4'],['PS5','PlayStation 5'],['Amiga','Amiga']])assert.equal(normalizePlatform(input),expected);
assert.deepEqual(providerPlatforms(['PC (Microsoft Windows)','PC','PlayStation 4']),['PC','PlayStation 4']);assert.deepEqual(providerPlatforms([]),[]);
});
