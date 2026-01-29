import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { PDFPageData, TextAnnotation, MergeRule } from '@/types/pdf';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

export async function loadPDFDocument(arrayBuffer: ArrayBuffer): Promise<pdfjsLib.PDFDocumentProxy> {
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer.slice(0) });
  return await loadingTask.promise;
}

export async function renderPageToCanvas(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  scale: number = 1
): Promise<string> {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.render({
    canvasContext: context,
    viewport: viewport,
    canvas: canvas,
  } as any).promise;

  return canvas.toDataURL('image/jpeg', 0.7);
}

export async function generateThumbnails(
  arrayBuffer: ArrayBuffer,
  scale: number = 0.3
): Promise<string[]> {
  const pdfDoc = await loadPDFDocument(arrayBuffer);
  const thumbnails: string[] = [];

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const thumbnail = await renderPageToCanvas(pdfDoc, i, scale);
    thumbnails.push(thumbnail);
  }

  return thumbnails;
}

export async function rotatePage(
  arrayBuffer: ArrayBuffer,
  pageIndex: number,
  degrees: number
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const pages = pdfDoc.getPages();
  
  if (pageIndex >= 0 && pageIndex < pages.length) {
    const currentRotation = pages[pageIndex].getRotation().angle;
    pages[pageIndex].setRotation({ type: 'degrees', angle: currentRotation + degrees } as any);
  }

  return await pdfDoc.save();
}

export async function rotatePages(
  arrayBuffer: ArrayBuffer,
  pageIndices: number[],
  degrees: number
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const pages = pdfDoc.getPages();

  pageIndices.forEach((pageIndex) => {
    if (pageIndex >= 0 && pageIndex < pages.length) {
      const currentRotation = pages[pageIndex].getRotation().angle;
      pages[pageIndex].setRotation({ type: 'degrees', angle: currentRotation + degrees } as any);
    }
  });

  return await pdfDoc.save();
}

export async function addTextToPage(
  arrayBuffer: ArrayBuffer,
  pageIndex: number,
  annotations: TextAnnotation[]
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const pages = pdfDoc.getPages();
  const page = pages[pageIndex];
  
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const { height } = page.getSize();

  for (const annotation of annotations) {
    const hexColor = annotation.color.replace('#', '');
    const r = parseInt(hexColor.substring(0, 2), 16) / 255;
    const g = parseInt(hexColor.substring(2, 4), 16) / 255;
    const b = parseInt(hexColor.substring(4, 6), 16) / 255;

    page.drawText(annotation.text, {
      x: annotation.x,
      y: height - annotation.y - annotation.fontSize,
      size: annotation.fontSize,
      font: font,
      color: rgb(r, g, b),
    });
  }

  return await pdfDoc.save();
}

export async function splitPDF(
  arrayBuffer: ArrayBuffer,
  ranges: MergeRule[]
): Promise<Uint8Array[]> {
  const sourcePdf = await PDFDocument.load(arrayBuffer);
  const results: Uint8Array[] = [];

  for (const range of ranges) {
    const newPdf = await PDFDocument.create();
    const pageIndices = [];
    
    for (let i = range.start; i <= range.end; i++) {
      pageIndices.push(i);
    }

    const copiedPages = await newPdf.copyPages(sourcePdf, pageIndices);
    copiedPages.forEach((page) => newPdf.addPage(page));

    results.push(await newPdf.save());
  }

  return results;
}

export async function mergePDFs(
  arrayBuffers: (ArrayBuffer | Uint8Array)[]
): Promise<Uint8Array> {
  const mergedPdf = await PDFDocument.create();

  for (const buffer of arrayBuffers) {
    const pdf = await PDFDocument.load(buffer);
    const pageIndices = pdf.getPageIndices();
    const copiedPages = await mergedPdf.copyPages(pdf, pageIndices);
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }

  return await mergedPdf.save();
}

export async function extractPages(
  arrayBuffer: ArrayBuffer,
  pageIndices: number[]
): Promise<Uint8Array> {
  const sourcePdf = await PDFDocument.load(arrayBuffer);
  const newPdf = await PDFDocument.create();

  const copiedPages = await newPdf.copyPages(sourcePdf, pageIndices);
  copiedPages.forEach((page) => newPdf.addPage(page));

  return await newPdf.save();
}

export async function reorderPages(
  arrayBuffer: ArrayBuffer,
  newOrder: number[]
): Promise<Uint8Array> {
  const sourcePdf = await PDFDocument.load(arrayBuffer);
  const newPdf = await PDFDocument.create();

  const copiedPages = await newPdf.copyPages(sourcePdf, newOrder);
  copiedPages.forEach((page) => newPdf.addPage(page));

  return await newPdf.save();
}

export async function cropPage(
  arrayBuffer: ArrayBuffer,
  pageIndex: number,
  cropBox: { x: number; y: number; width: number; height: number },
  pageWidth: number,
  pageHeight: number
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  const pages = pdfDoc.getPages();
  const page = pages[pageIndex];
  
  const { width, height } = page.getSize();
  
  // Convert from screen coordinates to PDF coordinates
  const scaleX = width / pageWidth;
  const scaleY = height / pageHeight;
  
  const x = cropBox.x * scaleX;
  const y = height - (cropBox.y + cropBox.height) * scaleY;
  const w = cropBox.width * scaleX;
  const h = cropBox.height * scaleY;

  page.setCropBox(x, y, w, h);

  return await pdfDoc.save();
}

export function parseMergeRules(input: string, maxPage: number): MergeRule[] {
  const rules: MergeRule[] = [];
  const parts = input.split(',').map(s => s.trim()).filter(s => s);

  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-').map(s => s.trim());
      const start = parseInt(startStr, 10) - 1;
      const end = parseInt(endStr, 10) - 1;
      
      if (!isNaN(start) && !isNaN(end) && start >= 0 && end < maxPage && start <= end) {
        rules.push({ start, end });
      }
    } else {
      const pageNum = parseInt(part, 10) - 1;
      if (!isNaN(pageNum) && pageNum >= 0 && pageNum < maxPage) {
        rules.push({ start: pageNum, end: pageNum });
      }
    }
  }

  return rules;
}

export async function getPageCount(arrayBuffer: ArrayBuffer): Promise<number> {
  const pdfDoc = await loadPDFDocument(arrayBuffer);
  return pdfDoc.numPages;
}

export function initializePages(pageCount: number): PDFPageData[] {
  return Array.from({ length: pageCount }, (_, i) => ({
    pageIndex: i,
    rotation: 0,
    selected: false,
    textAnnotations: [],
  }));
}
