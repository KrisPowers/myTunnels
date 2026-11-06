// Passkeys in the browser: the server sends options with binary fields as
// base64url, and gets the browser's answer back the same way.

export interface CreateOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  authenticatorSelection: AuthenticatorSelectionCriteria;
  attestation: AttestationConveyancePreference;
  excludeCredentials: { type: "public-key"; id: string }[];
  timeout: number;
}

export interface GetOptions {
  challenge: string;
  rpId: string;
  userVerification: UserVerificationRequirement;
  timeout: number;
}

export const passkeysWork = () => typeof window.PublicKeyCredential === "function";

// A prompt the person closed, or that timed out, is not an error to show.
export const dismissed = (e: unknown) => e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError");

function b64(buf: ArrayBuffer) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytes(s: string) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}

// What this device is called by default: its platform, such as "Windows".
export function deviceName() {
  const ua = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return ua?.platform || navigator.platform || "Passkey";
}

export async function createPasskey(o: CreateOptions) {
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: bytes(o.challenge),
      user: { ...o.user, id: bytes(o.user.id) },
      excludeCredentials: o.excludeCredentials.map((c) => ({ type: c.type, id: bytes(c.id) })),
    },
  })) as PublicKeyCredential;
  const r = cred.response as AuthenticatorAttestationResponse;
  return { id: b64(cred.rawId), clientDataJson: b64(r.clientDataJSON), attestationObject: b64(r.attestationObject) };
}

export async function signWithPasskey(o: GetOptions) {
  const cred = (await navigator.credentials.get({
    publicKey: { challenge: bytes(o.challenge), rpId: o.rpId, userVerification: o.userVerification, timeout: o.timeout },
  })) as PublicKeyCredential;
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: b64(cred.rawId),
    clientDataJson: b64(r.clientDataJSON),
    authenticatorData: b64(r.authenticatorData),
    signature: b64(r.signature),
  };
}
