import { useState, useCallback, useRef, useEffect } from 'react';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import type { PDFDocument as PDFDocType, TextAnnotation, TextSettings } from '@/types/pdf';
import {
  generateThumbnails,
  rotatePages,
  splitPDF,
  mergePDFs,
  extractPages,
  reorderPages,
  cropPage,
  parseMergeRules,
  getPageCount,
  initializePages,
  addTextToPage,
  loadPDFDocument,
  renderPageToCanvas,
} from '@/utils/pdfUtils';
import { cn } from '@/utils/cn';

type EditorMode = 'view' | 'text' | 'crop';

export function App() {
  const [documents, setDocuments] = useState<PDFDocType[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [activePageIndex, setActivePageIndex] = useState<number | null>(null);
  const [mode, setMode] = useState<EditorMode>('view');
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');
  const [selectedPages, setSelectedPages] = useState<Set<string>>(new Set());
  const [mergeRule, setMergeRule] = useState('');
  const [textSettings, setTextSettings] = useState<TextSettings>({
    fontSize: 16,
    fontFamily: 'Helvetica',
    color: '#000000',
  });
  const [currentAnnotations, setCurrentAnnotations] = useState<TextAnnotation[]>([]);
  const [cropBox, setCropBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [isCropping, setIsCropping] = useState(false);
  const [cropStart, setCropStart] = useState<{ x: number; y: number } | null>(null);
  const [pagePreview, setPagePreview] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const activeDoc = documents.find(d => d.id === activeDocId);

  // Handle file upload
  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setLoading(true);
    setLoadingMessage('載入PDF中...');

    try {
      const newDocs: PDFDocType[] = [];

      for (const file of Array.from(files)) {
        if (file.type !== 'application/pdf') continue;

        const arrayBuffer = await file.arrayBuffer();
        const pageCount = await getPageCount(arrayBuffer);
        const thumbnails = await generateThumbnails(arrayBuffer, 0.3);
        const pages = initializePages(pageCount);
        
        pages.forEach((page, i) => {
          page.thumbnail = thumbnails[i];
        });

        newDocs.push({
          id: crypto.randomUUID(),
          name: file.name.replace('.pdf', ''),
          arrayBuffer,
          pageCount,
          pages,
        });
      }

      setDocuments(prev => [...prev, ...newDocs]);
      if (newDocs.length > 0 && !activeDocId) {
        setActiveDocId(newDocs[0].id);
      }
    } catch (error) {
      console.error('Failed to load PDF:', error);
      alert('載入PDF失敗，請確認文件格式正確');
    } finally {
      setLoading(false);
      setLoadingMessage('');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [activeDocId]);

  // Toggle page selection
  const togglePageSelection = useCallback((docId: string, pageIndex: number) => {
    const key = `${docId}-${pageIndex}`;
    setSelectedPages(prev => {
      const newSet = new Set(prev);
      if (newSet.has(key)) {
        newSet.delete(key);
      } else {
        newSet.add(key);
      }
      return newSet;
    });
  }, []);

  // Select all pages of active document
  const selectAllPages = useCallback(() => {
    if (!activeDoc) return;
    const newSet = new Set<string>();
    activeDoc.pages.forEach((_, i) => {
      newSet.add(`${activeDoc.id}-${i}`);
    });
    setSelectedPages(newSet);
  }, [activeDoc]);

  // Clear selection
  const clearSelection = useCallback(() => {
    setSelectedPages(new Set());
  }, []);

  // Rotate selected pages
  const handleRotate = useCallback(async (degrees: number) => {
    if (!activeDoc || selectedPages.size === 0) return;
    
    setLoading(true);
    setLoadingMessage('旋轉頁面中...');

    try {
      const pageIndices = Array.from(selectedPages)
        .filter(key => key.startsWith(activeDoc.id))
        .map(key => parseInt(key.split('-')[1], 10));

      const newBuffer = await rotatePages(activeDoc.arrayBuffer, pageIndices, degrees);
      const thumbnails = await generateThumbnails(newBuffer.buffer as ArrayBuffer, 0.3);

      setDocuments(prev => prev.map(doc => {
        if (doc.id !== activeDoc.id) return doc;
        return {
          ...doc,
          arrayBuffer: newBuffer.buffer as ArrayBuffer,
          pages: doc.pages.map((page, i) => ({
            ...page,
            thumbnail: thumbnails[i],
            rotation: pageIndices.includes(i) ? page.rotation + degrees : page.rotation,
          })),
        };
      }));
    } catch (error) {
      console.error('Failed to rotate pages:', error);
      alert('旋轉頁面失敗');
    } finally {
      setLoading(false);
    }
  }, [activeDoc, selectedPages]);

  // Split PDF
  const handleSplit = useCallback(async () => {
    if (!activeDoc) return;

    setLoading(true);
    setLoadingMessage('拆分PDF中...');

    try {
      const rules = mergeRule.trim() 
        ? parseMergeRules(mergeRule, activeDoc.pageCount)
        : activeDoc.pages.map((_, i) => ({ start: i, end: i }));

      if (rules.length === 0) {
        alert('請輸入有效的拆分規則，例如：1-2,3,4-9,10');
        return;
      }

      const splitBuffers = await splitPDF(activeDoc.arrayBuffer, rules);
      
      const zip = new JSZip();
      splitBuffers.forEach((buffer, i) => {
        const paddedNum = String(i + 1).padStart(3, '0');
        zip.file(`${activeDoc.name}_${paddedNum}.pdf`, buffer);
      });

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      saveAs(zipBlob, `${activeDoc.name}_split.zip`);
    } catch (error) {
      console.error('Failed to split PDF:', error);
      alert('拆分PDF失敗');
    } finally {
      setLoading(false);
    }
  }, [activeDoc, mergeRule]);

  // Merge all documents
  const handleMergeAll = useCallback(async () => {
    if (documents.length < 2) {
      alert('請至少上傳兩個PDF文件進行合併');
      return;
    }

    setLoading(true);
    setLoadingMessage('合併PDF中...');

    try {
      const buffers = documents.map(d => d.arrayBuffer);
      const mergedBuffer = await mergePDFs(buffers);
      
      const blob = new Blob([new Uint8Array(mergedBuffer)], { type: 'application/pdf' });
      saveAs(blob, 'merged_document.pdf');
    } catch (error) {
      console.error('Failed to merge PDFs:', error);
      alert('合併PDF失敗');
    } finally {
      setLoading(false);
    }
  }, [documents]);

  // Extract selected pages
  const handleExtract = useCallback(async () => {
    if (!activeDoc || selectedPages.size === 0) return;

    setLoading(true);
    setLoadingMessage('提取頁面中...');

    try {
      const pageIndices = Array.from(selectedPages)
        .filter(key => key.startsWith(activeDoc.id))
        .map(key => parseInt(key.split('-')[1], 10))
        .sort((a, b) => a - b);

      const extracted = await extractPages(activeDoc.arrayBuffer, pageIndices);
      
      const blob = new Blob([new Uint8Array(extracted)], { type: 'application/pdf' });
      saveAs(blob, `${activeDoc.name}_extracted.pdf`);
    } catch (error) {
      console.error('Failed to extract pages:', error);
      alert('提取頁面失敗');
    } finally {
      setLoading(false);
    }
  }, [activeDoc, selectedPages]);

  // Delete selected pages
  const handleDeletePages = useCallback(async () => {
    if (!activeDoc || selectedPages.size === 0) return;

    const pageIndicesToDelete = Array.from(selectedPages)
      .filter(key => key.startsWith(activeDoc.id))
      .map(key => parseInt(key.split('-')[1], 10));

    if (pageIndicesToDelete.length === activeDoc.pageCount) {
      alert('無法刪除所有頁面');
      return;
    }

    setLoading(true);
    setLoadingMessage('刪除頁面中...');

    try {
      const remainingIndices = activeDoc.pages
        .map((_, i) => i)
        .filter(i => !pageIndicesToDelete.includes(i));

      const newBuffer = await extractPages(activeDoc.arrayBuffer, remainingIndices);
      const thumbnails = await generateThumbnails(newBuffer.buffer as ArrayBuffer, 0.3);
      const newPages = initializePages(remainingIndices.length);
      newPages.forEach((page, i) => {
        page.thumbnail = thumbnails[i];
      });

      setDocuments(prev => prev.map(doc => {
        if (doc.id !== activeDoc.id) return doc;
        return {
          ...doc,
          arrayBuffer: newBuffer.buffer as ArrayBuffer,
          pageCount: remainingIndices.length,
          pages: newPages,
        };
      }));

      setSelectedPages(new Set());
    } catch (error) {
      console.error('Failed to delete pages:', error);
      alert('刪除頁面失敗');
    } finally {
      setLoading(false);
    }
  }, [activeDoc, selectedPages]);

  // Move page
  const handleMovePage = useCallback(async (fromIndex: number, toIndex: number) => {
    if (!activeDoc || fromIndex === toIndex) return;

    setLoading(true);
    setLoadingMessage('移動頁面中...');

    try {
      const newOrder = activeDoc.pages.map((_, i) => i);
      const [removed] = newOrder.splice(fromIndex, 1);
      newOrder.splice(toIndex, 0, removed);

      const newBuffer = await reorderPages(activeDoc.arrayBuffer, newOrder);
      const thumbnails = await generateThumbnails(newBuffer.buffer as ArrayBuffer, 0.3);
      const newPages = initializePages(activeDoc.pageCount);
      newPages.forEach((page, i) => {
        page.thumbnail = thumbnails[i];
      });

      setDocuments(prev => prev.map(doc => {
        if (doc.id !== activeDoc.id) return doc;
        return {
          ...doc,
          arrayBuffer: newBuffer.buffer as ArrayBuffer,
          pages: newPages,
        };
      }));
    } catch (error) {
      console.error('Failed to move page:', error);
      alert('移動頁面失敗');
    } finally {
      setLoading(false);
    }
  }, [activeDoc]);

  // Open page editor
  const openPageEditor = useCallback(async (pageIndex: number) => {
    if (!activeDoc) return;

    setActivePageIndex(pageIndex);
    setMode('view');
    setCurrentAnnotations(activeDoc.pages[pageIndex].textAnnotations || []);

    try {
      const pdfDoc = await loadPDFDocument(activeDoc.arrayBuffer);
      const preview = await renderPageToCanvas(pdfDoc, pageIndex + 1, 1.5);
      setPagePreview(preview);

      const page = await pdfDoc.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1.5 });
      setPageSize({ width: viewport.width, height: viewport.height });
    } catch (error) {
      console.error('Failed to load page preview:', error);
    }
  }, [activeDoc]);

  // Close page editor
  const closePageEditor = useCallback(() => {
    setActivePageIndex(null);
    setMode('view');
    setCurrentAnnotations([]);
    setPagePreview(null);
    setCropBox(null);
  }, []);

  // Add text annotation
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== 'text' || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const newAnnotation: TextAnnotation = {
      id: crypto.randomUUID(),
      text: '新文字',
      x,
      y,
      fontSize: textSettings.fontSize,
      fontFamily: textSettings.fontFamily,
      color: textSettings.color,
      rotation: 0,
      width: 100,
      height: textSettings.fontSize + 4,
    };

    setCurrentAnnotations(prev => [...prev, newAnnotation]);
  }, [mode, textSettings]);

  // Crop handlers
  const handleCropMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== 'crop' || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    setCropStart({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    setIsCropping(true);
  }, [mode]);

  const handleCropMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isCropping || !cropStart || !canvasRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    setCropBox({
      x: Math.min(cropStart.x, currentX),
      y: Math.min(cropStart.y, currentY),
      width: Math.abs(currentX - cropStart.x),
      height: Math.abs(currentY - cropStart.y),
    });
  }, [isCropping, cropStart]);

  const handleCropMouseUp = useCallback(() => {
    setIsCropping(false);
    setCropStart(null);
  }, []);

  // Apply crop
  const applyCrop = useCallback(async () => {
    if (!activeDoc || activePageIndex === null || !cropBox) return;

    setLoading(true);
    setLoadingMessage('裁剪頁面中...');

    try {
      const newBuffer = await cropPage(
        activeDoc.arrayBuffer,
        activePageIndex,
        cropBox,
        pageSize.width,
        pageSize.height
      );

      const thumbnails = await generateThumbnails(newBuffer.buffer as ArrayBuffer, 0.3);

      setDocuments(prev => prev.map(doc => {
        if (doc.id !== activeDoc.id) return doc;
        return {
          ...doc,
          arrayBuffer: newBuffer.buffer as ArrayBuffer,
          pages: doc.pages.map((page, i) => ({
            ...page,
            thumbnail: thumbnails[i],
          })),
        };
      }));

      // Reload preview
      const pdfDoc = await loadPDFDocument(newBuffer.buffer as ArrayBuffer);
      const preview = await renderPageToCanvas(pdfDoc, activePageIndex + 1, 1.5);
      setPagePreview(preview);
      setCropBox(null);
    } catch (error) {
      console.error('Failed to crop page:', error);
      alert('裁剪頁面失敗');
    } finally {
      setLoading(false);
    }
  }, [activeDoc, activePageIndex, cropBox, pageSize]);

  // Save text annotations
  const saveAnnotations = useCallback(async () => {
    if (!activeDoc || activePageIndex === null || currentAnnotations.length === 0) return;

    setLoading(true);
    setLoadingMessage('保存文字中...');

    try {
      const newBuffer = await addTextToPage(
        activeDoc.arrayBuffer,
        activePageIndex,
        currentAnnotations
      );

      const thumbnails = await generateThumbnails(newBuffer.buffer as ArrayBuffer, 0.3);

      setDocuments(prev => prev.map(doc => {
        if (doc.id !== activeDoc.id) return doc;
        return {
          ...doc,
          arrayBuffer: newBuffer.buffer as ArrayBuffer,
          pages: doc.pages.map((page, i) => ({
            ...page,
            thumbnail: thumbnails[i],
            textAnnotations: i === activePageIndex ? [] : page.textAnnotations,
          })),
        };
      }));

      // Reload preview
      const pdfDoc = await loadPDFDocument(newBuffer.buffer as ArrayBuffer);
      const preview = await renderPageToCanvas(pdfDoc, activePageIndex + 1, 1.5);
      setPagePreview(preview);
      setCurrentAnnotations([]);
    } catch (error) {
      console.error('Failed to save annotations:', error);
      alert('保存文字失敗');
    } finally {
      setLoading(false);
    }
  }, [activeDoc, activePageIndex, currentAnnotations]);

  // Download current document
  const downloadDocument = useCallback(() => {
    if (!activeDoc) return;
    const blob = new Blob([activeDoc.arrayBuffer], { type: 'application/pdf' });
    saveAs(blob, `${activeDoc.name}_edited.pdf`);
  }, [activeDoc]);

  // Download all as ZIP
  const downloadAllAsZip = useCallback(async () => {
    if (documents.length === 0) return;

    setLoading(true);
    setLoadingMessage('打包下載中...');

    try {
      const zip = new JSZip();
      documents.forEach((doc, i) => {
        const paddedNum = String(i + 1).padStart(3, '0');
        zip.file(`${doc.name}_${paddedNum}.pdf`, doc.arrayBuffer);
      });

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      saveAs(zipBlob, 'pdf_documents.zip');
    } catch (error) {
      console.error('Failed to create ZIP:', error);
      alert('打包下載失敗');
    } finally {
      setLoading(false);
    }
  }, [documents]);

  // Delete document
  const deleteDocument = useCallback((docId: string) => {
    setDocuments(prev => prev.filter(d => d.id !== docId));
    if (activeDocId === docId) {
      setActiveDocId(documents.find(d => d.id !== docId)?.id || null);
    }
    setSelectedPages(prev => {
      const newSet = new Set<string>();
      prev.forEach(key => {
        if (!key.startsWith(docId)) {
          newSet.add(key);
        }
      });
      return newSet;
    });
  }, [activeDocId, documents]);

  // Update annotation
  const updateAnnotation = useCallback((id: string, updates: Partial<TextAnnotation>) => {
    setCurrentAnnotations(prev => prev.map(a => 
      a.id === id ? { ...a, ...updates } : a
    ));
  }, []);

  // Delete annotation
  const deleteAnnotation = useCallback((id: string) => {
    setCurrentAnnotations(prev => prev.filter(a => a.id !== id));
  }, []);

  // Draw canvas
  useEffect(() => {
    if (!canvasRef.current || !pagePreview) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d')!;
    const img = new Image();

    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);

      // Draw annotations
      currentAnnotations.forEach(annotation => {
        ctx.font = `${annotation.fontSize}px ${annotation.fontFamily}`;
        ctx.fillStyle = annotation.color;
        ctx.fillText(annotation.text, annotation.x, annotation.y + annotation.fontSize);
        
        // Draw selection box
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(
          annotation.x - 2,
          annotation.y,
          ctx.measureText(annotation.text).width + 4,
          annotation.fontSize + 4
        );
        ctx.setLineDash([]);
      });

      // Draw crop box
      if (cropBox && mode === 'crop') {
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 5]);
        ctx.strokeRect(cropBox.x, cropBox.y, cropBox.width, cropBox.height);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
        ctx.fillRect(cropBox.x, cropBox.y, cropBox.width, cropBox.height);
        ctx.setLineDash([]);
      }
    };

    img.src = pagePreview;
  }, [pagePreview, currentAnnotations, cropBox, mode]);

  const selectedCount = selectedPages.size;

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Loading overlay */}
      {loading && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-lg">{loadingMessage}</span>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="bg-gradient-to-r from-blue-600 to-purple-600 text-white shadow-lg">
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <h1 className="text-2xl font-bold">PDF Editor Pro</h1>
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                multiple
                onChange={handleFileUpload}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 bg-white text-blue-600 rounded-lg font-medium hover:bg-blue-50 transition-colors flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                上傳PDF
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-6">
        {documents.length === 0 ? (
          /* Upload prompt */
          <div className="bg-white rounded-xl shadow-lg p-12 text-center">
            <div className="max-w-md mx-auto">
              <div className="w-24 h-24 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg className="w-12 h-12 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-gray-800 mb-2">開始編輯PDF</h2>
              <p className="text-gray-500 mb-6">上傳PDF文件開始編輯，支援批量上傳和離線操作</p>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors inline-flex items-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                選擇文件
              </button>
            </div>
          </div>
        ) : activePageIndex !== null && activeDoc ? (
          /* Page Editor View */
          <div className="bg-white rounded-xl shadow-lg overflow-hidden">
            <div className="border-b p-4 flex items-center justify-between bg-gray-50">
              <div className="flex items-center gap-4">
                <button
                  onClick={closePageEditor}
                  className="p-2 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                  </svg>
                </button>
                <h2 className="font-semibold text-lg">
                  編輯頁面 {activePageIndex + 1} / {activeDoc.pageCount}
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setMode('view')}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                    mode === 'view' ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-100'
                  )}
                >
                  檢視
                </button>
                <button
                  onClick={() => setMode('text')}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                    mode === 'text' ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-100'
                  )}
                >
                  添加文字
                </button>
                <button
                  onClick={() => setMode('crop')}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
                    mode === 'crop' ? 'bg-blue-100 text-blue-700' : 'hover:bg-gray-100'
                  )}
                >
                  裁剪
                </button>
              </div>
            </div>

            <div className="flex">
              {/* Canvas area */}
              <div className="flex-1 p-6 bg-gray-100 flex justify-center overflow-auto" style={{ maxHeight: '70vh' }}>
                <canvas
                  ref={canvasRef}
                  onClick={handleCanvasClick}
                  onMouseDown={handleCropMouseDown}
                  onMouseMove={handleCropMouseMove}
                  onMouseUp={handleCropMouseUp}
                  onMouseLeave={handleCropMouseUp}
                  className={cn(
                    'shadow-lg',
                    mode === 'text' && 'cursor-text',
                    mode === 'crop' && 'cursor-crosshair'
                  )}
                />
              </div>

              {/* Side panel */}
              <div className="w-72 border-l bg-white p-4 space-y-4">
                {mode === 'text' && (
                  <>
                    <div>
                      <h3 className="font-semibold mb-3">文字設定</h3>
                      <div className="space-y-3">
                        <div>
                          <label className="block text-sm text-gray-600 mb-1">字體大小</label>
                          <input
                            type="number"
                            value={textSettings.fontSize}
                            onChange={(e) => setTextSettings(prev => ({ ...prev, fontSize: parseInt(e.target.value) || 16 }))}
                            className="w-full px-3 py-2 border rounded-lg"
                            min="8"
                            max="72"
                          />
                        </div>
                        <div>
                          <label className="block text-sm text-gray-600 mb-1">顏色</label>
                          <input
                            type="color"
                            value={textSettings.color}
                            onChange={(e) => setTextSettings(prev => ({ ...prev, color: e.target.value }))}
                            className="w-full h-10 rounded-lg cursor-pointer"
                          />
                        </div>
                      </div>
                    </div>

                    {currentAnnotations.length > 0 && (
                      <div>
                        <h3 className="font-semibold mb-3">已添加文字 ({currentAnnotations.length})</h3>
                        <div className="space-y-2 max-h-48 overflow-y-auto">
                          {currentAnnotations.map((annotation) => (
                            <div key={annotation.id} className="p-2 bg-gray-50 rounded-lg text-sm">
                              <input
                                type="text"
                                value={annotation.text}
                                onChange={(e) => updateAnnotation(annotation.id, { text: e.target.value })}
                                className="w-full px-2 py-1 border rounded mb-1"
                              />
                              <button
                                onClick={() => deleteAnnotation(annotation.id)}
                                className="text-red-500 text-xs hover:underline"
                              >
                                刪除
                              </button>
                            </div>
                          ))}
                        </div>
                        <button
                          onClick={saveAnnotations}
                          className="w-full mt-3 px-4 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors"
                        >
                          保存文字到PDF
                        </button>
                      </div>
                    )}

                    <p className="text-sm text-gray-500">
                      點擊頁面上任意位置添加文字
                    </p>
                  </>
                )}

                {mode === 'crop' && (
                  <>
                    <div>
                      <h3 className="font-semibold mb-3">裁剪設定</h3>
                      <p className="text-sm text-gray-500 mb-3">
                        在頁面上拖曳選取要保留的區域
                      </p>
                      {cropBox && (
                        <div className="text-sm text-gray-600 mb-3">
                          <p>X: {Math.round(cropBox.x)}, Y: {Math.round(cropBox.y)}</p>
                          <p>寬: {Math.round(cropBox.width)}, 高: {Math.round(cropBox.height)}</p>
                        </div>
                      )}
                    </div>
                    <button
                      onClick={applyCrop}
                      disabled={!cropBox || cropBox.width < 10 || cropBox.height < 10}
                      className="w-full px-4 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      應用裁剪
                    </button>
                    <button
                      onClick={() => setCropBox(null)}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg font-medium hover:bg-gray-50 transition-colors"
                    >
                      清除選取
                    </button>
                  </>
                )}

                {mode === 'view' && (
                  <div className="text-sm text-gray-500">
                    <p>選擇模式以開始編輯：</p>
                    <ul className="mt-2 space-y-1">
                      <li>• <strong>添加文字</strong>：點擊添加可編輯文字</li>
                      <li>• <strong>裁剪</strong>：拖曳選取保留區域</li>
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* Main View - Document & Page Grid */
          <div className="flex gap-6">
            {/* Document list sidebar */}
            <div className="w-64 flex-shrink-0">
              <div className="bg-white rounded-xl shadow-lg overflow-hidden">
                <div className="p-4 border-b bg-gray-50">
                  <h2 className="font-semibold">文件列表 ({documents.length})</h2>
                </div>
                <div className="divide-y max-h-96 overflow-y-auto">
                  {documents.map((doc) => (
                    <div
                      key={doc.id}
                      className={cn(
                        'p-3 cursor-pointer transition-colors group',
                        activeDocId === doc.id ? 'bg-blue-50' : 'hover:bg-gray-50'
                      )}
                      onClick={() => setActiveDocId(doc.id)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium truncate text-sm">{doc.name}</p>
                          <p className="text-xs text-gray-500">{doc.pageCount} 頁</p>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteDocument(doc.id);
                          }}
                          className="p-1 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="p-3 border-t space-y-2">
                  <button
                    onClick={handleMergeAll}
                    disabled={documents.length < 2}
                    className="w-full px-3 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    合併所有文件
                  </button>
                  <button
                    onClick={downloadAllAsZip}
                    disabled={documents.length === 0}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    下載全部 (ZIP)
                  </button>
                </div>
              </div>
            </div>

            {/* Main content area */}
            <div className="flex-1">
              {activeDoc ? (
                <div className="bg-white rounded-xl shadow-lg overflow-hidden">
                  {/* Toolbar */}
                  <div className="p-4 border-b bg-gray-50">
                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <h2 className="font-semibold text-lg">{activeDoc.name}</h2>
                      <div className="flex items-center gap-2 flex-wrap">
                        {selectedCount > 0 && (
                          <span className="text-sm text-gray-500 mr-2">
                            已選 {selectedCount} 頁
                          </span>
                        )}
                        <button
                          onClick={selectAllPages}
                          className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-100 transition-colors"
                        >
                          全選
                        </button>
                        <button
                          onClick={clearSelection}
                          className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-100 transition-colors"
                        >
                          取消選擇
                        </button>
                        <div className="h-6 w-px bg-gray-300" />
                        <button
                          onClick={() => handleRotate(-90)}
                          disabled={selectedCount === 0}
                          className="px-3 py-1.5 text-sm bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          title="逆時針旋轉90°"
                        >
                          ↶ 旋轉
                        </button>
                        <button
                          onClick={() => handleRotate(90)}
                          disabled={selectedCount === 0}
                          className="px-3 py-1.5 text-sm bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          title="順時針旋轉90°"
                        >
                          旋轉 ↷
                        </button>
                        <button
                          onClick={handleExtract}
                          disabled={selectedCount === 0}
                          className="px-3 py-1.5 text-sm bg-green-100 text-green-700 rounded-lg hover:bg-green-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          提取頁面
                        </button>
                        <button
                          onClick={handleDeletePages}
                          disabled={selectedCount === 0}
                          className="px-3 py-1.5 text-sm bg-red-100 text-red-700 rounded-lg hover:bg-red-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          刪除頁面
                        </button>
                      </div>
                    </div>

                    {/* Split/merge controls */}
                    <div className="mt-4 flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-2 flex-1 min-w-64">
                        <label className="text-sm text-gray-600 whitespace-nowrap">拆分規則:</label>
                        <input
                          type="text"
                          value={mergeRule}
                          onChange={(e) => setMergeRule(e.target.value)}
                          placeholder="例如: 1-2,3,4-9,10"
                          className="flex-1 px-3 py-1.5 border rounded-lg text-sm"
                        />
                        <button
                          onClick={handleSplit}
                          className="px-3 py-1.5 text-sm bg-orange-100 text-orange-700 rounded-lg hover:bg-orange-200 transition-colors whitespace-nowrap"
                        >
                          拆分並下載
                        </button>
                      </div>
                      <div className="h-6 w-px bg-gray-300" />
                      <button
                        onClick={downloadDocument}
                        className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                      >
                        下載此文件
                      </button>
                    </div>
                  </div>

                  {/* Page grid */}
                  <div className="p-6">
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                      {activeDoc.pages.map((page, index) => {
                        const isSelected = selectedPages.has(`${activeDoc.id}-${index}`);
                        return (
                          <div
                            key={index}
                            className={cn(
                              'group relative bg-white border-2 rounded-lg overflow-hidden cursor-pointer transition-all hover:shadow-lg',
                              isSelected ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200 hover:border-gray-300'
                            )}
                          >
                            {/* Thumbnail */}
                            <div
                              onClick={() => openPageEditor(index)}
                              className="aspect-[3/4] bg-gray-100 flex items-center justify-center"
                            >
                              {page.thumbnail ? (
                                <img
                                  src={page.thumbnail}
                                  alt={`Page ${index + 1}`}
                                  className="w-full h-full object-contain"
                                />
                              ) : (
                                <div className="text-gray-400">
                                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                  </svg>
                                </div>
                              )}
                            </div>

                            {/* Selection checkbox */}
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                togglePageSelection(activeDoc.id, index);
                              }}
                              className="absolute top-2 left-2"
                            >
                              <div className={cn(
                                'w-6 h-6 rounded border-2 flex items-center justify-center transition-colors',
                                isSelected ? 'bg-blue-500 border-blue-500' : 'bg-white/80 border-gray-300 hover:border-blue-400'
                              )}>
                                {isSelected && (
                                  <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </div>
                            </div>

                            {/* Page number & controls */}
                            <div className="p-2 bg-gray-50 border-t flex items-center justify-between">
                              <span className="text-sm font-medium text-gray-600">頁 {index + 1}</span>
                              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                {index > 0 && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleMovePage(index, index - 1);
                                    }}
                                    className="p-1 hover:bg-gray-200 rounded"
                                    title="向前移動"
                                  >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                                    </svg>
                                  </button>
                                )}
                                {index < activeDoc.pages.length - 1 && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleMovePage(index, index + 1);
                                    }}
                                    className="p-1 hover:bg-gray-200 rounded"
                                    title="向後移動"
                                  >
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                    </svg>
                                  </button>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-white rounded-xl shadow-lg p-12 text-center">
                  <p className="text-gray-500">請從左側選擇一個文件</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="mt-8 py-4 text-center text-sm text-gray-500">
        <p>PDF Editor Pro - 完全離線運行的PDF編輯器</p>
        <p className="mt-1">支援上傳、旋轉、合併、拆分、裁剪和添加文字</p>
      </footer>
    </div>
  );
}
