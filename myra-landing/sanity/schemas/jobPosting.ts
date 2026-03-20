import { defineType, defineField } from 'sanity'

export const jobPosting = defineType({
  name: 'jobPosting',
  title: 'Job Posting',
  type: 'document',
  fields: [
    defineField({
      name: 'title',
      title: 'Job Title',
      type: 'string',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'location',
      title: 'Location',
      type: 'string',
      description: 'e.g. "Remote / Toronto" or "On-site, Chicago"',
    }),
    defineField({
      name: 'type',
      title: 'Employment Type',
      type: 'string',
      options: {
        list: [
          { title: 'Full-time', value: 'Full-time' },
          { title: 'Part-time', value: 'Part-time' },
          { title: 'Contract', value: 'Contract' },
          { title: 'Internship', value: 'Internship' },
        ],
      },
    }),
    defineField({
      name: 'description',
      title: 'Job Description',
      type: 'text',
      rows: 4,
    }),
    defineField({
      name: 'active',
      title: 'Active',
      type: 'boolean',
      initialValue: true,
      description: 'Uncheck to hide this posting without deleting it.',
    }),
    defineField({
      name: 'order',
      title: 'Sort Order',
      type: 'number',
      initialValue: 0,
    }),
  ],
  preview: {
    select: {
      title: 'title',
      subtitle: 'location',
      active: 'active',
    },
    prepare({ title, subtitle, active }) {
      return {
        title: `${active ? '' : '[HIDDEN] '}${title}`,
        subtitle,
      }
    },
  },
})
