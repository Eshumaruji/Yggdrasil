/**
 * Firebase WEB config + app settings.
 *
 * Firebase Console > Project settings > General > "Your apps" > Web app > SDK config.
 * NOTE: this is NOT serviceAccountKey.json. That file is a private admin key
 * for the FastAPI backend and must never be shipped to a browser.
 *
 * Also enable the sign-in methods in Console > Authentication > Sign-in method:
 * Email/Password and Google. Add your domain under Authentication > Settings >
 * Authorised domains (localhost is allowed by default).
 */
export const firebaseConfig = {
  apiKey: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDSOTRnrEs/Kp94\nY5+gUc+rsIEEWDzZJnAi7aWaDBEZFdj3XzgnSO4y11ADMVtEMu8iBYkKppyAY4fs\nsuiacubN3Tyvr/Jt91/1TEpfYOjXxfDt1kY+CZOfdTqrqyTQmmUAQsQ3nLyZGwDd\ncmvO5CnP8SPucVmWdlIZLouY7w1N5p98OchkFQDaMp+M7fepwMrOVEBZU6xp9WK/\nN0gQultFTmI2I28wD/MfuYWOpobqgBSz+9Wv7YFpWLHAAEmDwfXNJ7Dh1yIu1yYB\nQU3mteydzxfhtL9804quElSpdY3LT4m3RSknHGYIRgkAfcKxOhDiwiwJA2AuQOFQ\nOilJMbxTAgMBAAECggEAH8qB188blAJcmmaqcaKy8++zGxaYS8Mp1cZi3ZXHPNLB\nJxZRwMh2folxcqzTSfrP5LEPRTqRU+3OqjzGEJv2tm7SFMQtYR7goTu3yuO2DUdv\nBMX7hQ81XA8XinV3vEoqTaygeBkuVj2vVvh3lZKLQNniiVZqlLvw9MOasyEs6GOF\nBRbM7vqTK7sc7MUIsausQOsYQirW3FhJu97hvkLfTcDZzAStRvY0mqhAdAq3ZrR5\nxV8j7e8h6Zxn+TRH0ufCxduSYPYebPTBIzNVP7mPLdG2rfcbNeqg7qPyBCrWFHxs\nSD+UeZqpLTFtBmTqhi3IIiexsmFrdnKoxKfqib/x7QKBgQD+z0O1KVMyQVJX32w8\nxiYQFxgH5IZjbJVPCEy1rbK9moXunGGtKnYh0I6gFxs5WpVjmhaYkNQuXY0r5IPt\nY5OBoZVr64goWkuhbqX0a7COuQ2bdnagD1dNN3KTM51fBZ2h6HOKm38ZK3QDee+T\natZnXi5U/vGgsukLr3KLkNATvQKBgQDTNJ479gW5VutuLBorKfTsFFcZ3LF3EywY\ng83AOBNDgM4ERnsH+bTY63mQZVVtPIon6WJU3tt5LaITcYO/IgEuehhiBlLHueIp\nyw4yXh4TcfOP+xNi4gpI8TsXRSHdrIcLyzBdDD717htaP9ivi76SkbvgY1KvZbGz\ngbSWSRIJTwKBgQCkJQyu5WIs25uZ89mcBOF8OARJAVP5NHeyo9wWpUChl6tznNXn\nYZUcD2fxhTEKb2oQ8bBgs9ubyrQodFrwT9c0CM1i6iWaKSDTa54IqF7ich9r6JJe\nZcONgIyUewmDrvBu3nmf7q+fnThtDN3ij05y5F7gbiNlrBsoZetaMP152QKBgB/q\n477L/zFzIUEVCR9cx9alfEQ8RdVo4FEUGhPiZYbeAERFInKiGeJuM4DOz4oii/5c\nFrAcva4iZ0vo67AGw4byjJzDt97XCIaoWQzjjEgEAHrRxqw63LMJQZTSrbuCRyZR\nHo3xO9KOmTOaUnS0+afMvke6utQm2iP2hgPwJvmhAoGATbPbfBa2YM/Z6lIfKosg\n/BPhJa4lm1B3F3C7L09VFrGoBZh60gMQXl8TgPK2OzGLlTMPOwZD9r96tUkA6R0V\nmfvROXC71jrE6N1RJkns0UojvPfeMhq0WaDuOWzzTo1hP5Y1WAReZbMKn1Cj/hyY\n8e08p5suS0jrmx2fLkk81SA=\n-----END PRIVATE KEY-----\n",
  authDomain: "yggdrasil-six-sepia.vercel.app",
  projectId: "yggdrasil-46247",
  appId: "39f86777d6de8ba7bbd6aaa393e6ceb7553bfdf5",
};

/** FastAPI base URL (uvicorn main:app --reload). */
export const API_BASE = "http://127.0.0.1:8000";

/**
 * Public endpoint for the landing-page map. Expected response:
 *   { blood_banks: [{ id, name, address, phone, lat, lng, distance_km, ... }] }
 * Your existing /requestors/{id}/nearby-blood-banks returns this shape but needs
 * a requestor id, so add a public route such as GET /blood-banks/nearby?lat&lng&radius_km.
 * Until it exists the page shows clearly-labelled demo data.
 */
export const NEARBY_ENDPOINT = "/blood-banks/nearby";
export const SEARCH_RADIUS_KM = 25; // matches NEARBY_RADIUS_KM in requestors.py

/** Where each role goes after sign-in. */
export const ROLE_ROUTES = {
  donor: "donor.html",
  blood_bank: "blood-bank.html",
  requestor: "requestor.html",
};
export const ROLE_LABELS = { donor: "Donor", blood_bank: "Blood bank", requestor: "Requestor" };
