import { path } from '../path.js'
import { create, list, type Transport } from '../transport.js'
import type {
  FormSubmission,
  FormSubmissionReceipt,
  ListParams,
  Page,
  RequestOptions,
  SubmitFormInput,
  WriteResult,
} from '../types/index.js'

export function formSubmissionsResource(t: Transport) {
  return {
    /** One page of form entries with their answers. */
    list: (params?: ListParams): Promise<Page<FormSubmission>> =>
      list(t, path`/form-submissions`, params),
    /** Sends a form entry, as a site visitor would. */
    create: (input: SubmitFormInput, options?: RequestOptions): Promise<WriteResult<FormSubmissionReceipt>> =>
      create(t, path`/form-submissions`, input, options),
  }
}

export type FormSubmissionsResource = ReturnType<typeof formSubmissionsResource>
