export interface PDFPageData {
  pageIndex: number;
  rotation: number;
  thumbnail?: string;
  selected: boolean;
  textAnnotations: TextAnnotation[];
  cropBox?: CropBox;
}

export interface TextAnnotation {
  id: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  fontFamily: string;
  color: string;
  rotation: number;
  width: number;
  height: number;
}

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PDFDocument {
  id: string;
  name: string;
  arrayBuffer: ArrayBuffer;
  pageCount: number;
  pages: PDFPageData[];
}

export interface MergeRule {
  start: number;
  end: number;
}

export interface EditorState {
  documents: PDFDocument[];
  activeDocId: string | null;
  activePageIndex: number | null;
  mode: 'view' | 'text' | 'crop';
  textSettings: TextSettings;
  selectedPages: Set<string>;
}

export interface TextSettings {
  fontSize: number;
  fontFamily: string;
  color: string;
}
