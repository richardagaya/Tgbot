const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { firebaseEnabled, getBucket } = require('./firebase-app');

function storageEnabled() {
  try {
    return firebaseEnabled() && Boolean(getBucket());
  } catch {
    return false;
  }
}

function cleanObjectPart(value) {
  return String(value || 'file').replace(/[^\w.\- ()/]/g, '_').replace(/^\/+/, '');
}

function storageObjectName(...parts) {
  return parts.map(cleanObjectPart).filter(Boolean).join('/');
}

async function uploadLocalFile(localPath, objectName, metadata = {}) {
  if (!storageEnabled()) throw new Error('Firebase Storage is not configured');
  const bucket = getBucket();
  await bucket.upload(localPath, {
    destination: objectName,
    metadata: {
      contentType: metadata.contentType || 'application/zip',
      metadata: metadata.metadata || {},
    },
  });
  return objectName;
}

async function deletePrefix(prefix) {
  if (!storageEnabled()) return;
  const bucket = getBucket();
  const [files] = await bucket.getFiles({ prefix });
  await Promise.all(files.map((file) => file.delete().catch(() => null)));
}

async function downloadToTemp(objectName, filename = 'download.zip') {
  if (!storageEnabled()) throw new Error('Firebase Storage is not configured');
  const bucket = getBucket();
  const safeName = path.basename(String(filename || 'download.zip'));
  const tmp = path.join(os.tmpdir(), `firebase-${Date.now()}-${Math.random().toString(16).slice(2)}-${safeName}`);
  await bucket.file(objectName).download({ destination: tmp });
  return tmp;
}

function createReadStream(objectName) {
  if (!storageEnabled()) throw new Error('Firebase Storage is not configured');
  return getBucket().file(objectName).createReadStream();
}

async function uploadStream(readable, objectName, metadata = {}) {
  if (!storageEnabled()) throw new Error('Firebase Storage is not configured');
  const file = getBucket().file(objectName);
  await pipeline(
    readable,
    file.createWriteStream({
      metadata: {
        contentType: metadata.contentType || 'application/zip',
        metadata: metadata.metadata || {},
      },
    })
  );
  return objectName;
}

function fileExists(localPath) {
  try {
    return fs.existsSync(localPath);
  } catch {
    return false;
  }
}

async function objectExists(objectName) {
  if (!storageEnabled()) return false;
  try {
    const bucket = getBucket();
    const [exists] = await bucket.file(objectName).exists();
    return exists;
  } catch {
    return false;
  }
}

async function getObjectSize(objectName) {
  if (!storageEnabled()) return null;
  try {
    const bucket = getBucket();
    const [metadata] = await bucket.file(objectName).getMetadata();
    return Number(metadata.size) || 0;
  } catch {
    return null;
  }
}

async function getSignedDownloadUrl(objectName, expiresMs = 24 * 60 * 60 * 1000) {
  if (!storageEnabled()) throw new Error('Firebase Storage is not configured');
  const bucket = getBucket();
  const [url] = await bucket.file(objectName).getSignedUrl({
    action: 'read',
    expires: Date.now() + expiresMs,
  });
  return url;
}

async function getSignedUploadUrl(objectName, contentType = 'application/zip', expiresMs = 15 * 60 * 1000) {
  if (!storageEnabled()) throw new Error('Firebase Storage is not configured');
  const bucket = getBucket();
  const [url] = await bucket.file(objectName).getSignedUrl({
    action: 'write',
    contentType,
    expires: Date.now() + expiresMs,
  });
  return url;
}

module.exports = {
  storageEnabled,
  storageObjectName,
  uploadLocalFile,
  uploadStream,
  deletePrefix,
  downloadToTemp,
  createReadStream,
  fileExists,
  objectExists,
  getObjectSize,
  getSignedDownloadUrl,
  getSignedUploadUrl,
};
