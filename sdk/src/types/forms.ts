export interface FormSubmission {
  id: string
  formId: string
  locale: string
  data: Record<string, unknown>
  submittedAt: string
}

export interface SubmitFormInput {
  formId: string
  formMode: string
  submissionData: Record<string, unknown>
  name?: string
  email?: string
  phone?: string
  address?: string
  message?: string
  productId?: string
  turnstileToken?: string | null
}

/**
 * What `formSubmissions.create` answers with. The fields can be missing or
 * null when the platform accepted an entry without storing it.
 */
export interface FormSubmissionReceipt {
  id?: string | null
  formId?: string | null
  submittedAt?: string | null
}
