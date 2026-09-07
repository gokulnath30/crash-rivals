import { decodeDataset, encodeDataset, EMPTY_DATASET, type Dataset } from '@domain/motion/dataset.ts';

/**
 * Where the recordings live between visits.
 *
 * The browser's own storage, on this machine, and nowhere else. No video is
 * ever kept — a sample is a label and a list of numbers — and nothing is sent
 * anywhere. The file export exists so the dataset can be taken somewhere that
 * trains a larger model.
 */
const STORAGE_KEY = 'training-space.dataset.v1';

export function loadDataset(): Dataset {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text ? decodeDataset(text) : EMPTY_DATASET;
  } catch {
    // Private browsing, or a quota that has been used up elsewhere.
    return EMPTY_DATASET;
  }
}

/** @returns whether it actually persisted, so the room can say if it did not. */
export function saveDataset(dataset: Dataset): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, encodeDataset(dataset));
    return true;
  } catch {
    return false;
  }
}

/** Hands the dataset to the browser as a file to save. */
export function downloadDataset(dataset: Dataset): void {
  const blob = new Blob([encodeDataset(dataset)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  link.download = `pose-dataset-${stamp}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next tick, so the click has had the object to work with.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

/** Reads a dataset file the person picked. Never throws. */
export async function readDatasetFile(file: File): Promise<Dataset> {
  try {
    return decodeDataset(await file.text());
  } catch {
    return EMPTY_DATASET;
  }
}
