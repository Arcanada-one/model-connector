export interface CatalogModel {
  id: string;
  free: boolean;
  contextLength?: number;
  promptPrice?: number;
  completionPrice?: number;
  modality?: string;
}

export interface ProviderCatalogAdapter {
  readonly provider: string;
  fetch(signal?: AbortSignal): Promise<CatalogModel[]>;
}
