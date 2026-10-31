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
