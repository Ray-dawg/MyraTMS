import { defineType, defineField } from 'sanity'

export const siteConfig = defineType({
  name: 'siteConfig',
  title: 'Site Configuration',
  type: 'document',
  fields: [
    defineField({
      name: 'companyName',
      title: 'Company Name',
      type: 'string',
      initialValue: 'Myra AI',
    }),
    defineField({
      name: 'tagline',
      title: 'Footer Tagline',
      type: 'text',
      rows: 2,
    }),
    defineField({
      name: 'phone',
      title: 'Phone Number',
      type: 'string',
    }),
    defineField({
      name: 'email',
      title: 'Primary Email',
      type: 'string',
    }),
    defineField({
      name: 'socialLinks',
      title: 'Social Media Links',
      type: 'object',
      fields: [
        defineField({ name: 'linkedin', title: 'LinkedIn URL', type: 'url' }),
        defineField({ name: 'twitter', title: 'Twitter/X URL', type: 'url' }),
        defineField({ name: 'github', title: 'GitHub URL', type: 'url' }),
        defineField({ name: 'youtube', title: 'YouTube URL', type: 'url' }),
      ],
    }),
  ],
  preview: {
    prepare() {
      return { title: 'Site Configuration' }
    },
  },
})
