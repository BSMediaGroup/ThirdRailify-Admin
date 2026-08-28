import assert from "node:assert/strict";
import test from "node:test";
import { resolveCoarseLocation, searchCoarseLocations } from "../functions/_shared/goats-geocoder.js";

const features = [{ type: "Feature", geometry: { type: "Point", coordinates: [151.20931, -33.86882] }, properties: { type: "house", name: "10 Example Street", city: "Sydney", state: "New South Wales", country: "Australia", countrycode: "AU" } }];
const fetchImpl = async () => Response.json({ features });

test("location autocomplete strips street detail and returns a city choice", async () => {
  const payload = await searchCoarseLocations({}, { query: "10 Example Street Sydney", countryCode: "AU" }, { fetchImpl });
  assert.deepEqual(payload.results, [{ id: "sydney-new south wales-AU", city: "Sydney", region: "New South Wales", countryCode: "AU", countryName: "Australia", label: "Sydney, New South Wales, Australia" }]);
  assert.equal(JSON.stringify(payload).includes("Example Street"), false);
});

test("final resolution stores a rounded city-level point", async () => {
  const location = await resolveCoarseLocation({}, { city: "Sydney", region: "New South Wales", countryCode: "AU" }, { fetchImpl });
  assert.deepEqual(location, { city: "Sydney", region: "New South Wales", countryCode: "AU", latitude: -33.87, longitude: 151.21, label: "Sydney, New South Wales, Australia", provider: "photon-city" });
});
