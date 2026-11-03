import { CompositionSpec } from '@creativanta/contracts';

export interface CuratedTemplate {
  id: string;
  revision: number;
  name: string;
  description: string;
  variables_schema: Record<string, unknown>;
  defaults: Record<string, unknown>;
  supported_locales: string[];
  required_capabilities: string[];
  composition_spec: CompositionSpec;
}
