const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const sendOTPEmail = async (email, name, otp) => {
  await transporter.sendMail({
    from: `"TAMS System" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Your Password Reset OTP",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
        <h2 style="color: #1d4ed8; margin-bottom: 8px;">Password Reset</h2>
        <p style="color: #374151;">Hi <strong>${name}</strong>,</p>
        <p style="color: #374151;">Your OTP code to reset your password is:</p>
        <div style="text-align: center; margin: 24px 0;">
          <span style="font-size: 36px; font-weight: bold; letter-spacing: 10px; color: #1d4ed8; background: #eff6ff; padding: 16px 24px; border-radius: 8px;">
            ${otp}
          </span>
        </div>
        <p style="color: #6b7280; font-size: 14px;">This code expires in <strong>10 minutes</strong>.</p>
        <p style="color: #6b7280; font-size: 14px;">If you didn't request this, ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
        <p style="color: #9ca3af; font-size: 12px;">TAMS — Travel Agency Management System</p>
      </div>
    `,
  });
};

module.exports = { sendOTPEmail };
