import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

const provider = new GoogleAuthProvider();
for (const scope of SCOPES) {
  provider.addScope(scope);
}

// Flag to indicate if we are in the middle of a sign-in flow.
let isSigningIn = false;
// Cache the access token and opaque backend session ID in memory ONLY (never in localStorage or sessionStorage).
let cachedAccessToken: string | null = null;
let cachedBackendSessionId: string | null = null;

async function syncBackendOAuthSession(
  accessToken: string,
  user: User
): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Google-Access-Token': accessToken,
      },
      body: JSON.stringify({
        accessToken,
        userEmail: user.email || undefined,
        userName: user.displayName || undefined,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.sessionId) {
        cachedBackendSessionId = data.sessionId;
        return data.sessionId;
      }
    }
  } catch (err) {
    console.warn('Backend OAuth session sync warning:', err);
  }
  return null;
}

export const initAuth = (
  onAuthSuccess?: (user: User, token: string | null, sessionId: string | null) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        if (!cachedBackendSessionId) {
          await syncBackendOAuthSession(cachedAccessToken, user);
        }
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken, cachedBackendSessionId);
      } else if (!isSigningIn) {
        // Check if backend still holds a valid HttpOnly cookie session
        try {
          const sessRes = await fetch('/api/auth/session');
          if (sessRes.ok) {
            const sessData = await sessRes.json();
            if (sessData.authenticated && sessData.sessionId) {
              cachedBackendSessionId = sessData.sessionId;
              if (onAuthSuccess) onAuthSuccess(user, null, cachedBackendSessionId);
              return;
            }
          }
        } catch {
          // ignore
        }
        cachedAccessToken = null;
        cachedBackendSessionId = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      cachedBackendSessionId = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{
  user: User;
  accessToken: string;
  sessionId: string | null;
} | null> => {
  try {
    isSigningIn = true;
    provider.setCustomParameters({
      prompt: 'select_account',
    });
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain Google OAuth access token from sign-in.');
    }

    cachedAccessToken = credential.accessToken;
    const sessionId = await syncBackendOAuthSession(cachedAccessToken, result.user);
    return {
      user: result.user,
      accessToken: cachedAccessToken,
      sessionId,
    };
  } catch (error: any) {
    console.error('Google Sign-In error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const getBackendSessionId = (): string | null => {
  return cachedBackendSessionId;
};

export const logout = async () => {
  try {
    const sidQuery = cachedBackendSessionId
      ? `?sid=${encodeURIComponent(cachedBackendSessionId)}`
      : '';
    await fetch(`/api/auth/session${sidQuery}`, { method: 'DELETE' });
  } catch {
    // ignore
  }
  await auth.signOut();
  cachedAccessToken = null;
  cachedBackendSessionId = null;
};

export interface DriveVideoItem {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  thumbnailLink?: string;
  webViewLink?: string;
  videoMediaMetadata?: {
    width?: number;
    height?: number;
    durationMillis?: string;
  };
}

export async function listUserDriveVideos(
  accessToken: string,
  searchQuery = ''
): Promise<DriveVideoItem[]> {
  const sanitizedQuery = searchQuery.replace(/'/g, "\\'").trim();
  const qParts = ["mimeType contains 'video/'", 'trashed = false'];
  if (sanitizedQuery) {
    qParts.push(`name contains '${sanitizedQuery}'`);
  }
  const q = encodeURIComponent(qParts.join(' and '));
  const fields = encodeURIComponent(
    'files(id,name,mimeType,size,thumbnailLink,webViewLink,videoMediaMetadata)'
  );

  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=24&orderBy=modifiedTime desc&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (res.status === 401) {
    throw new Error('Your Google Sign-In session has expired. Please sign in with Google again.');
  }
  if (res.status === 403) {
    throw new Error('Google Drive permission denied. Please ensure Drive read access was granted.');
  }
  if (res.status === 429) {
    throw new Error('Google Drive API rate limit reached. Please wait a moment and try again.');
  }
  if (!res.ok) {
    throw new Error('Unable to list videos from your Google Drive.');
  }

  const data = await res.json();
  return data.files || [];
}
