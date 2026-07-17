export declare const CONTRACT_VERSION: string

export type ToolSpecDialect = 'anthropic' | 'openai' | 'mcp'

export interface ToolParamDescriptor {
  name: string
  type: 'string' | 'integer' | 'object'
  required?: boolean
  description?: string
}

export interface ToolDescriptor {
  name: string
  id: string
  description: string
  params: ToolParamDescriptor[]
}

export interface Descriptors {
  contract_version: string
  tools: ToolDescriptor[]
}

export interface Capabilities {
  contract_version: string
  tools: string[]
  features: {
    dataframe_query: boolean
    attachments: boolean
    file_allowlist: boolean
    max_execution_time: boolean
    resource_caps: boolean
    network_watchdog: boolean
    async: boolean
    streaming: boolean
    [feature: string]: boolean
  }
}

export declare function loadDescriptors(): Descriptors
export declare function toolSpecs(dialect?: ToolSpecDialect): object[]
export declare function capabilities(): Capabilities
