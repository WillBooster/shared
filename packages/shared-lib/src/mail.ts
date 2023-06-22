export interface MailData {
  from: string;
  subject: string;
  text: string;
}

class MailTemplates {
  resetPassword(appName: string, resetUrl: string, expirationDuration?: string): MailData {
    return {
      from: 'no-reply@willbooster.dev',
      subject: 'パスワード再設定のご案内',
      text: `
${appName}をご利用いただき誠にありがとうございます。

お客様からパスワード再設定のリクエストを受け取りました。
以下のURLをクリックして、新しいパスワードを設定してください。

${resetUrl}
${
  expirationDuration
    ? `
なお、上記のURLは発行から約${expirationDuration}で失効します。
期限を過ぎてしまった場合や、URLが機能しない場合は、
恐れ入りますが、再度パスワードを再設定してください。
`
    : ''
}
引き続き${appName}をよろしくお願い申し上げます。

${appName} サポートチーム
    `.trim(),
    };
  }
}

export const mailTemplates = new MailTemplates();
