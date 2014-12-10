using System;
using System.Linq;
using System.Web;

namespace MC10
{
    /// <summary>
    /// Summary description for SaveCassette
    /// </summary>
    public class SaveCassette : IHttpHandler
    {
        public void ProcessRequest(HttpContext context)
        {
            var fname = context.Request["filename"];
            var data = context.Request["cassette-data"];
            var base64CharArray = data.ToArray();

            byte[] binaryData;
            binaryData = System.Convert.FromBase64CharArray(base64CharArray, 0, base64CharArray.Length);

            context.Response.Clear();
            context.Response.AppendHeader("Content-Disposition", String.Format("attachment; filename={0}.c10", fname.ToUpper()));
            context.Response.ContentType = "application/octet-stream";
            context.Response.BinaryWrite(binaryData);
            context.Response.End();
        }

        public bool IsReusable
        {
            get
            {
                return false;
            }
        }
    }
}